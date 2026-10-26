package dev.andy.piide

import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor

/**
 * 协议 v0.2 的数据结构与序列化。见 repo 根 docs/protocol.md。
 *
 * 手写 JSON 而不是引 gson:字段少、格式固定,不引入任何依赖就不会在
 * 平台版本之间踩到 classloader / 内部库的坑。
 */
internal data class Position(val line: Int, val column: Int)

internal data class Selection(
	val start: Position,
	val end: Position,
	val text: String,
	val selectedAt: Long?,
)

internal data class BufferState(
	val file: String?,
	val name: String,
	val language: String?,
	val cursor: Position?,
	val selection: Selection?,
	val modified: Boolean,
	val linesTotal: Int,
)

internal data class EditorState(
	val pid: Long,
	val cwd: String,
	val timestamp: Long,
	/** 协议里的 `app`:JetBrains IDE 统一报 "jetbrains" */
	val app: String = "jetbrains",
	/**
	 * 同一 `app` 下的具体产品("WebStorm" / "PyCharm" / "DataGrip"...)。
	 * pi 端靠它选图标和显示名——否则 `/ide` 里四个 IDE 全都叫 jetbrains。
	 */
	val product: String? = null,
	/** 用启动指纹同义的字段区分同 cwd 多实例:这里放「产品名 + 项目名」 */
	val argv: List<String> = emptyList(),
	/** 已经序列化好的 `database` 对象片段;只有 DataGrip / IDEA Ultimate 的表视图会给 */
	val database: String? = null,
	val activeBuffer: BufferState,
) {
	fun toJson(): String = buildString(256) {
		append("{\"pid\":").append(pid)
		append(",\"cwd\":\"").append(escape(cwd)).append('"')
		append(",\"timestamp\":").append(timestamp)
		append(",\"app\":\"").append(escape(app)).append('"')
		if (product != null) append(",\"product\":\"").append(escape(product)).append('"')
		append(",\"argv\":[")
		append(argv.joinToString(",") { "\"${escape(it)}\"" })
		append(']')
		if (database != null) append(",\"database\":").append(database)
		append(",\"active_buffer\":")
		append(activeBuffer.toJson())
		append('}')
	}
}

private fun BufferState.toJson(): String = buildString(160) {
	append("{\"file\":").append(file?.let { "\"${escape(it)}\"" } ?: "null")
	append(",\"name\":\"").append(escape(name)).append('"')
	append(",\"language\":").append(language?.let { "\"${escape(it)}\"" } ?: "null")
	append(",\"cursor\":").append(cursor?.toJson() ?: "null")
	append(",\"selection\":").append(selection?.toJson() ?: "null")
	append(",\"modified\":").append(modified)
	append(",\"lines_total\":").append(linesTotal)
	append('}')
}

private fun Position.toJson(): String = "{\"line\":$line,\"column\":$column}"

private fun Selection.toJson(): String = buildString(64) {
	append("{\"start\":").append(start.toJson())
	append(",\"end\":").append(end.toJson())
	append(",\"text\":\"").append(escape(text)).append('"')
	append(",\"selected_at\":").append(selectedAt ?: "null")
	append('}')
}

/** 控制字符必须转义,否则 SelectedText 里的 \u0000(U+0000)会让 pi 端 JSON.parse 直接炸 */
internal fun escape(s: String): String {
	val sb = StringBuilder(s.length + 8)
	for (c in s) {
		when {
			c == '"' -> sb.append("\\\"")
			c == '\\' -> sb.append("\\\\")
			c == '\n' -> sb.append("\\n")
			c == '\r' -> sb.append("\\r")
			c == '\t' -> sb.append("\\t")
			c < ' ' -> sb.append(String.format("\\u%04x", c.code))
			else -> sb.append(c)
		}
	}
	return sb.toString()
}

/**
 * 从项目当前选中的编辑器采集状态。必须在读锁下调用(EDT)。
 *
 * `lastSelectionAt` 来自 PiIdeTracker:协议里 selection.selected_at 表示
 * "用户最后一次做出非空选择的时刻",pi 端据此判断 60s 新鲜度。
 */
internal object PiIdeState {
	fun build(project: Project, lastSelectionAt: Long?, nowSec: Long): EditorState {
		val fileEditor: FileEditor? = com.intellij.openapi.fileEditor.FileEditorManager
			.getInstance(project)
			.selectedEditor
		val file: VirtualFile? = fileEditor?.file
		val editor: Editor? = (fileEditor as? TextEditor)?.editor

		return EditorState(
			pid = ProcessHandle.current().pid(),
			cwd = project.basePath ?: System.getProperty("user.dir"),
			timestamp = nowSec,
			product = productName(),
			argv = listOfNotNull(ideFingerprint(), project.name),
			// 表视图不是 TextEditor,光标/选区给不出来;能给的只有数据库上下文
			database = fileEditor?.let { databaseContext(project, it) },
			activeBuffer = buffer(file, editor, lastSelectionAt),
		)
	}

	private fun buffer(file: VirtualFile?, editor: Editor?, lastSelectionAt: Long?): BufferState {
		// 只有本地文件才有能交给模型的绝对路径;非本地(截图 / 远程)按未命名缓冲区处理
		val path = file?.takeIf { it.isInLocalFileSystem }?.path
		val document: Document? = file?.let { FileDocumentManager.getInstance().getDocument(it) }
		val name = file?.name ?: "[No File]"

		if (editor == null || document == null) {
			return BufferState(
				file = path,
				name = name,
				language = languageOf(file),
				cursor = null,
				selection = null,
				modified = document?.let { isUnsaved(it) } ?: false,
				linesTotal = document?.lineCount ?: 0,
			)
		}

		val caret = editor.caretModel.currentCaret
		val selectionModel = editor.selectionModel
		val selection = if (selectionModel.hasSelection()) {
			val from = minOf(selectionModel.selectionStart, selectionModel.selectionEnd)
			val to = maxOf(selectionModel.selectionStart, selectionModel.selectionEnd)
			val range = TextRange(from, to)
			Selection(
				start = positionOf(document, from),
				end = positionOf(document, to),
				text = selectionModel.selectedText ?: document.getText(range),
				selectedAt = lastSelectionAt,
			)
		} else {
			null
		}

		return BufferState(
			file = path,
			name = name,
			language = languageOf(file),
			cursor = positionOf(document, caret.offset),
			selection = selection,
			modified = isUnsaved(document),
			linesTotal = document.lineCount,
		)
	}

	/** Document.isModified 在 2026.2 被移除,统一走 FileDocumentManager */
	private fun isUnsaved(document: Document): Boolean =
		FileDocumentManager.getInstance().isDocumentUnsaved(document)

	/** 1-based 行 / 1-based 列(UTF-16 码元,与 VS Code 客户端一致) */
	private fun positionOf(document: Document, offset: Int): Position {
		val clamped = offset.coerceIn(0, document.textLength)
		val line = document.getLineNumber(clamped)
		return Position(line = line + 1, column = clamped - document.getLineStartOffset(line) + 1)
	}

	/**
	 * JetBrains 报的是 FileType 名("TypeScript" / "SQL" / "Kotlin"),
	 * 小写后正好和 pi 端图标表里的小写 language id 对上;对不上就走扩展名兜底。
	 */
	private fun languageOf(file: VirtualFile?): String? =
		languageIdOf(file?.fileType?.name)
}

/**
 * 兜底文件类型不给模型看:WebStorm 没装对应语言插件时,`.py` 会落到 TextMate
 * bundle,FileType 名就是 "TextMate",注入成 `Language: textmate` 是纯噪声。
 * 返回 null 后由 pi 端按文件扩展名判定(它本来就有这张表)。
 */
internal fun languageIdOf(fileTypeName: String?): String? {
	val name = fileTypeName?.lowercase()?.takeIf { it.isNotBlank() } ?: return null
	return name.takeIf { it !in GENERIC_FILE_TYPES }
}

private val GENERIC_FILE_TYPES = setOf("textmate", "plain text", "text", "unknown", "database element")
