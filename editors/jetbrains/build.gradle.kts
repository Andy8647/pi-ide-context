plugins {
	id("java")
	id("org.jetbrains.kotlin.jvm") version "2.4.21"
	id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "dev.andy"
version = "0.1.0"

// 只依赖 IntelliJ Platform 通用 API(<depends>com.intellij.modules.platform</depends>),
// 所以同一个 zip 能装进 WebStorm / PyCharm / IDEA / DataGrip / GoLand。
repositories {
	mavenCentral()
	intellijPlatform { defaultRepositories() }
}

dependencies {
	intellijPlatform {
		// 本地迭代不必下载一整份 IDE:./gradlew buildPlugin -PlocalIdePath="/Applications/WebStorm.app"
		val localIde = providers.gradleProperty("localIdePath").orNull
		if (localIde != null) {
			local(localIde)
		} else {
			intellijIdeaCommunity("2025.2.5")
		}
	}

	// 协议 JSON 的单元测试只用 kotlin.test,不拉平台 test fixtures。
	// 注意:IntelliJ Platform Gradle 插件把测试任务当 JUnit4 用,所以走 junit4 变体。
	testImplementation(kotlin("test-junit"))
	testImplementation("junit:junit:4.13.2")
}

kotlin {
	jvmToolchain(21)
}

java {
	sourceCompatibility = JavaVersion.VERSION_21
	targetCompatibility = JavaVersion.VERSION_21
}

intellijPlatform {
	// 没有 settings/ 表单,跳过较慢的索引构建
	buildSearchableOptions = false

	pluginConfiguration {
		ideaVersion {
			// 编译基线 2025.2(本机 IC CE / PyCharm CE);要往下放必须先跑 pluginVerifier
			sinceBuild = "252"
			// 不设上限:新版 IDE 直接能装
			untilBuild = provider { null }
		}
	}

	// 磁盘安装(GitHub release zip)不需要签名;上传 Marketplace 时由 JetBrains 代为签名
}
