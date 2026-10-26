package dev.andy.piide

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

/** 每个项目窗口启动时挂载一次追踪(一个 IDE 进程可能开多个窗口) */
class PiIdeStartup : ProjectActivity {
	override suspend fun execute(project: Project) {
		PiIdeTracker.install(project)
	}
}
