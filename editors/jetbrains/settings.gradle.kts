pluginManagement {
	repositories {
		gradlePluginPortal()
		mavenCentral()
	}
}

plugins {
	// 让 jvmToolchain(21) 在没装 JDK 21 的机器(和 CI)上自动下载
	id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

rootProject.name = "pi-ide-context-jetbrains"
