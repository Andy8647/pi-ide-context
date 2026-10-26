package dev.andy.piide.database

import com.intellij.database.datagrid.CoreDatabaseGridDataHookUp
import com.intellij.database.datagrid.GridColumn
import com.intellij.database.datagrid.GridModel
import com.intellij.database.datagrid.GridRow
import com.intellij.database.datagrid.ModelIndex
import com.intellij.database.editor.DataGridContainer
import com.intellij.database.model.DasForeignKey
import com.intellij.database.model.DasTable
import com.intellij.database.run.ui.DataAccessType
import com.intellij.database.util.DasUtil
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.project.Project
import dev.andy.piide.DatabaseContextProvider
import dev.andy.piide.escape

/**
 * Reads the table view (DataGrip / IDEA Ultimate) into the state file's `database` block.
 *
 * Everything here comes from the model the IDE has already introspected — no connection,
 * no round trip, and nothing the user has to wait for. The one consequence: a table the
 * user only reached through a result set may have no `DasTable`, in which case the grid
 * still reports its name, the selected cell and the filter, and the schema part is
 * simply absent.
 *
 * Every list is capped on purpose. A 300-column table must not turn a prompt into a
 * schema dump — the summary is there so the model can reason about *this* query, not to
 * replace introspection.
 */
class DataGridContext : DatabaseContextProvider {
	override fun describe(project: Project, editor: FileEditor): String? {
		val grid = (editor as? DataGridContainer)?.dataGrid ?: return null
		val hookup = grid.dataHookup as? CoreDatabaseGridDataHookUp
		val table = hookup?.databaseTable as? DasTable
		val model = grid.getDataModel(DataAccessType.DATA_WITH_MUTATIONS)

		val selection = grid.selectionModel
		val row = runCatching { selection.selectedRow }.getOrNull()
		val column = runCatching { selection.selectedColumn }.getOrNull()

		val parts = mutableListOf<String>()
		parts += field("table", runCatching { table?.name ?: grid.displayName }.getOrNull())
		parts += field("data_source", runCatching { hookup?.dataSource?.name }.getOrNull())
		parts += field("schema", runCatching { table?.let { DasUtil.getSchema(it) } }.getOrNull())

		if (table != null) {
			primaryKey(table)?.let { parts += strings("primary_key", it) }
			val all = runCatching { DasUtil.getColumns(table).toList() }.getOrNull() ?: emptyList()
			parts += columns(all.take(COLUMN_LIMIT))
			if (all.size > COLUMN_LIMIT) parts += "\"columns_total\":${all.size}"
			foreignKeys(table)?.let { parts += it }
		}

		runCatching { grid.filterText }.getOrNull()?.takeIf { it.isNotBlank() }?.let {
			parts += field("filter", it.take(FILTER_LIMIT))
		}

		if (row != null) parts += "\"row_count\":${model.rowCount}"
		cell(hookup, model, row, column)?.let { parts += it }

		// A grid with nothing readable is not worth a block in the prompt.
		return if (parts.size <= 1) null else "{" + parts.filter { it.isNotBlank() }.joinToString(",") + "}"
	}

	private fun primaryKey(table: DasTable): List<String>? =
		runCatching {
			DasUtil.getPrimaryKey(table)?.columnsRef?.names()?.toList()?.takeIf { it.isNotEmpty() }
		}.getOrNull()

	private fun columns(shown: List<com.intellij.database.model.DasColumn>): String {
		val json = shown.joinToString(",") { column ->
			val type = runCatching { column.dasType?.toDataType()?.typeName }.getOrNull()
			"{\"name\":${quote(column.name)}" + (type?.let { ",\"type\":${quote(it)}" } ?: "") + "}"
		}
		return "\"columns\":[$json]"
	}

	private fun foreignKeys(table: DasTable): String? {
		val keys = runCatching { DasUtil.getForeignKeys(table).toList() }.getOrNull() ?: return null
		if (keys.isEmpty()) return null
		val json = keys.take(FK_LIMIT).joinToString(",") { it.toJson() }
		return "\"foreign_keys\":[$json]"
	}

	private fun DasForeignKey.toJson(): String {
		val parts = mutableListOf<String>()
		runCatching { columnsRef.names().toList() }.getOrNull()?.let { parts += strings("columns", it) }
		parts += field("ref_table", refTable())
		runCatching { refColumns.names().toList() }.getOrNull()?.let { parts += strings("ref_columns", it) }
		runCatching { deleteRule?.name }.getOrNull()?.let { parts += field("on_delete", it) }
		return "{" + parts.filter { it.isNotBlank() }.joinToString(",") + "}"
	}

	private fun DasForeignKey.refTable(): String? {
		val name = runCatching { refTableName }.getOrNull() ?: return null
		val schema = runCatching { refTableSchema }.getOrNull()
		return if (schema.isNullOrBlank()) name else "$schema.$name"
	}

	private fun cell(
		hookup: CoreDatabaseGridDataHookUp?,
		model: GridModel<GridRow, GridColumn>,
		row: ModelIndex<GridRow>?,
		column: ModelIndex<GridColumn>?,
	): String? {
		if (row == null || column == null) return null

		val gridColumn = runCatching { model.getColumn(column) }.getOrNull()
		val dasColumn = gridColumn?.let { runCatching { hookup?.getDatabaseColumn(it) }.getOrNull() }
		val raw = runCatching { model.getValueAt(row, column) }.getOrNull()

		val parts = mutableListOf<String>()
		parts += "\"row\":${row.asInteger() + 1}"
		(dasColumn?.name ?: gridColumn?.let { runCatching { it.name }.getOrNull() })?.let {
			parts += field("column", it)
		}
		runCatching { dasColumn?.dasType?.toDataType()?.typeName }.getOrNull()?.let { parts += field("type", it) }
		parts += field("value", literal(raw))
		return "\"cell\":{" + parts.filter { it.isNotBlank() }.joinToString(",") + "}"
	}

	/**
	 * A cell value as JSON. Binary data must never reach a prompt, and a multi-megabyte
	 * text cell would eat the whole budget, so both degrade to a note instead.
	 */
	private fun literal(value: Any?): String? = when {
		value == null -> "null"
		value is ByteArray -> quote("<${value.size} bytes>")
		value is CharArray -> quote(String(value).take(VALUE_LIMIT))
		else -> {
			val text = runCatching { value.toString() }.getOrNull() ?: return quote("<unprintable>")
			val shown = text.take(VALUE_LIMIT)
			quote(if (shown.length < text.length) "$shown… (${text.length} chars)" else shown)
		}
	}

	/** `"key":value`, or "" when the value is missing — callers filter blanks out. */
	private fun field(key: String, value: String?): String =
		if (value.isNullOrBlank()) "" else "\"$key\":${quote(value)}"

	private fun strings(key: String, values: List<String>): String =
		"\"$key\":[" + values.joinToString(",") { quote(it) } + "]"

	private fun quote(text: String): String = "\"" + escape(text) + "\""

	private companion object {
		const val COLUMN_LIMIT = 40
		const val FK_LIMIT = 10
		const val VALUE_LIMIT = 200
		const val FILTER_LIMIT = 160
	}
}
