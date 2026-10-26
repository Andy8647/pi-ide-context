package dev.andy.piide

import com.intellij.ide.AppLifecycleListener
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Computable
import com.intellij.openapi.util.Disposer
import com.intellij.util.Alarm
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap

/** 产品名,例如 "WebStorm" / "PyCharm" / "DataGrip";写进协议的 `product` */
internal fun productName(): String? = try {
	ApplicationInfo.getInstance().versionName
} catch (_: Throwable) {
	null
}

/** 产品名 + 版本,例如 "WebStorm 2026.2.3";塞进协议的 argv 字段当同 cwd 实例指纹 */
internal fun ideFingerprint(): String? = try {
	val info = ApplicationInfo.getInstance()
	"${info.versionName} ${info.fullVersion}"
} catch (_: Throwable) {
	null
}

/**
 * 采集「当前项目窗口的活动编辑器」并落盘。
 *
 * 与 VS Code / Obsidian 客户端的差别:JetBrains 一个进程可以开多个项目窗口
 * (同一个 pid),协议 v0.2 的 <pid>.json 只能装一份状态,所以这里采用
 * 「最后碰过的窗口胜出」——用户切窗口后通常第一下就点进编辑器,状态随之更新。
 * 多窗口并行追踪需要协议支持多实例文件,留待 v0.3。
 */
internal object PiIdeTracker {
	private const val DEBOUNCE_MS = 200

	private val disposable = Disposer.newDisposable("pi-ide-context")
	private val alarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, disposable)
	private val installedProjects: MutableSet<Project> =
		Collections.newSetFromMap(ConcurrentHashMap())

	@Volatile
	private var lastProject: Project? = null

	/** 用户最后一次做出非空选择的时刻(unix 秒);切文件后归零 = 视为过期 */
	@Volatile
	private var lastSelectionAt: Long? = null

	@Volatile
	private var appWired = false

	fun install(project: Project) {
		wireAppListeners()
		if (!installedProjects.add(project)) return

		project.messageBus.connect(disposable).subscribe(
			FileEditorManagerListener.FILE_EDITOR_MANAGER,
			object : FileEditorManagerListener {
				// 切换活动文件:新文件的选区年龄未知(可能来自会话恢复),按过期处理
				override fun selectionChanged(event: FileEditorManagerEvent) {
					lastProject = project
					lastSelectionAt = null
					flush(project)
				}
			},
		)

		lastProject = project
		flush(project)
	}

	@Synchronized
	private fun wireAppListeners() {
		if (appWired) return
		appWired = true

		// 应用级 multicaster:一次挂载覆盖所有项目窗口的所有编辑器
		val multicaster = EditorFactory.getInstance().eventMulticaster

		multicaster.addCaretListener(
			object : CaretListener {
				override fun caretPositionChanged(event: CaretEvent) {
					event.editor.project?.let { lastProject = it }
					schedule()
				}
			},
			disposable,
		)

		multicaster.addSelectionListener(
			object : SelectionListener {
				override fun selectionChanged(event: SelectionEvent) {
					event.editor.project?.let { lastProject = it }
					if (!event.newRange.isEmpty) lastSelectionAt = nowSec()
					schedule()
				}
			},
			disposable,
		)

		multicaster.addDocumentListener(
			object : DocumentListener {
				// 行数 / modified 变化;保存时也会走到这里
				override fun documentChanged(event: DocumentEvent) {
					schedule()
				}
			},
			disposable,
		)

		// 正常退出清理。IDE 被 kill 时不会触发,pi 端靠 kill(pid, 0) 判定失效
		ApplicationManager.getApplication().messageBus.connect(disposable).subscribe(
			AppLifecycleListener.TOPIC,
			object : AppLifecycleListener {
				override fun appClosing() {
					PiIdeStateWriter.remove(ProcessHandle.current().pid())
				}
			},
		)
	}

	private fun schedule() {
		alarm.cancelAllRequests()
		alarm.addRequest({ flush(lastProject) }, DEBOUNCE_MS)
	}

	private fun flush(project: Project?) {
		if (project == null || project.isDisposed) return

		val json = try {
			ApplicationManager.getApplication().runReadAction(
				Computable { PiIdeState.build(project, lastSelectionAt, nowSec()).toJson() },
			)
		} catch (_: Throwable) {
			return
		}

		val pid = ProcessHandle.current().pid()
		ApplicationManager.getApplication()
			.executeOnPooledThread { PiIdeStateWriter.write(pid, json) }
	}

	private fun nowSec(): Long = System.currentTimeMillis() / 1000
}
