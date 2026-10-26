package dev.andy.piide

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Pins the wire format. The pi side parses this JSON with `JSON.parse`, so a
 * changed key or a mis-escaped character here is a silent protocol break — not
 * something the compiler would catch.
 */
class EditorStateJsonTest {
	@Test
	fun `serializes the v0_2 shape field for field`() {
		val state = EditorState(
			pid = 123,
			cwd = "/tmp/proj",
			timestamp = 1700000000,
			product = "WebStorm",
			argv = listOf("WebStorm 2026.2.3", "proj"),
			activeBuffer = BufferState(
				file = "/tmp/proj/src/main.ts",
				name = "main.ts",
				language = "typescript",
				cursor = Position(line = 42, column = 10),
				selection = null,
				modified = false,
				linesTotal = 200,
			),
		)

		assertEquals(
			"""{"pid":123,"cwd":"/tmp/proj","timestamp":1700000000,"app":"jetbrains",""" +
				""""product":"WebStorm","argv":["WebStorm 2026.2.3","proj"],"active_buffer":{""" +
				""""file":"/tmp/proj/src/main.ts","name":"main.ts","language":"typescript",""" +
				""""cursor":{"line":42,"column":10},"selection":null,"modified":false,""" +
				""""lines_total":200}}""",
			state.toJson(),
		)
	}

	@Test
	fun `selection carries normalized range and freshness stamp`() {
		val state = EditorState(
			pid = 1,
			cwd = "/tmp",
			timestamp = 1700000000,
			activeBuffer = BufferState(
				file = null,
				name = "[No File]",
				language = null,
				cursor = null,
				selection = Selection(
					start = Position(3, 1),
					end = Position(5, 8),
					text = "a\nb",
					selectedAt = 1700000000,
				),
				modified = true,
				linesTotal = 9,
			),
		)

		val json = state.toJson()
		assert(json.endsWith(
			""""active_buffer":{"file":null,"name":"[No File]","language":null,"cursor":null,""" +
				""""selection":{"start":{"line":3,"column":1},"end":{"line":5,"column":8},""" +
				""""text":"a\nb","selected_at":1700000000},"modified":true,"lines_total":9}}""",
		)) { json }
	}

	@Test
	fun `escapes what would otherwise break JSON parse`() {
		val json = EditorState(
			pid = 1,
			cwd = "/tmp",
			timestamp = 0,
			activeBuffer = BufferState(
				file = "/tmp/a b.ts",
				name = "a b.ts",
				language = "typescript",
				cursor = Position(1, 1),
				selection = Selection(
					start = Position(1, 1),
					end = Position(1, 2),
					text = "say \"hi\"\tand\\stop\u0000",
					selectedAt = null,
				),
				modified = false,
				linesTotal = 1,
			),
		).toJson()

		assert(json.contains("\"text\":\"say \\\"hi\\\"\\tand\\\\stop\\u0000\"")) { json }
	}

	@Test
	fun `placeholder file types do not leak into the prompt`() {
		assertNull(languageIdOf("TextMate"))
		assertNull(languageIdOf("Plain Text"))
		assertNull(languageIdOf(" "))
		assertNull(languageIdOf(null))
		assertEquals("typescript", languageIdOf("TypeScript"))
		assertEquals("sql", languageIdOf("SQL"))
		assertEquals("python", languageIdOf("Python"))
	}
}
