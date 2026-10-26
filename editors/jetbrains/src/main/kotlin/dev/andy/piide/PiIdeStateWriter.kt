package dev.andy.piide

import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions

/**
 * 写 <state_dir>/<pid>.json,规则见 repo 根 docs/protocol.md:
 * state_dir = $XDG_RUNTIME_DIR/pi-ide,否则 /tmp/pi-ide;目录 0700、文件 0600;
 * 先写 .tmp 再 rename,避免 pi 端读到半截 JSON。
 *
 * 一切异常都吞掉:插件写盘失败绝不能影响 IDE 本身。
 */
internal object PiIdeStateWriter {
	private fun stateDir(): Path {
		val base = System.getenv("XDG_RUNTIME_DIR")?.takeIf { it.isNotBlank() } ?: "/tmp"
		return Paths.get(base, "pi-ide")
	}

	fun write(pid: Long, json: String) {
		try {
			val dir = stateDir()
			Files.createDirectories(dir)
			setPerms(dir, "rwx------")

			val tmp = dir.resolve("$pid.json.tmp")
			val target = dir.resolve("$pid.json")
			Files.write(
				tmp,
				json.toByteArray(StandardCharsets.UTF_8),
				StandardOpenOption.CREATE,
				StandardOpenOption.TRUNCATE_EXISTING,
				StandardOpenOption.WRITE,
			)
			try {
				Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
			} catch (_: AtomicMoveNotSupportedException) {
				Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING)
			}
			setPerms(target, "rw-------")
		} catch (_: IOException) {
			// 尽力而为
		} catch (_: SecurityException) {
			// 尽力而为
		}
	}

	fun remove(pid: Long) {
		try {
			Files.deleteIfExists(stateDir().resolve("$pid.json"))
		} catch (_: IOException) {
			// 退出清理失败无所谓:pi 端用 kill(pid, 0) 判断进程是否还活着
		}
	}

	private fun setPerms(path: Path, perms: String) {
		try {
			Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(perms))
		} catch (_: Exception) {
			// 非 POSIX 文件系统(理论上 macOS/Linux 之外)直接跳过
		}
	}
}
