package dev.andy.piide

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.project.Project
import com.intellij.openapi.extensions.ExtensionPointName

/**
 * Optional bridge to the JetBrains "Database" plugin (DataGrip, IDEA Ultimate).
 *
 * The implementation lives in `pi-ide-database.xml`, which is only loaded when
 * `com.intellij.database` is present, so WebStorm / PyCharm / GoLand never see a
 * `com.intellij.database.*` class and the plugin does not need a hard dependency
 * on a paid IDE feature.
 *
 * Returns an already-serialized JSON object for the state file's `database` key,
 * or null when the selected editor is not a table. Keeping the contract a string
 * is what lets this interface live in the always-loaded jar: no shared types, no
 * classloader games.
 */
interface DatabaseContextProvider {
	fun describe(project: Project, editor: FileEditor): String?
}

private val DATABASE_CONTEXT_EP =
	ExtensionPointName.create<DatabaseContextProvider>("dev.andy.piide.databaseContext")

/**
 * Ask whatever database provider is installed. A provider that throws (a table
 * half-loaded, an introspection still running) must not take the state write
 * with it, so failures read as "no database context".
 */
internal fun databaseContext(project: Project, editor: FileEditor): String? {
	val providers = try {
		DATABASE_CONTEXT_EP.extensionList
	} catch (_: Throwable) {
		return null
	}
	for (provider in providers) {
		val json = try {
			provider.describe(project, editor)
		} catch (_: Throwable) {
			null
		}
		if (json != null) return json
	}
	return null
}
