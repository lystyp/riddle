pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven { url = uri("https://jitpack.io") }
        // Boox repos serve plain http; keep them after the official ones so
        // standard artifacts never resolve through them.
        maven {
            url = uri("http://repo.boox.com/repository/proxy-public/")
            isAllowInsecureProtocol = true
        }
        maven {
            url = uri("http://repo.boox.com/repository/maven-public/")
            isAllowInsecureProtocol = true
        }
    }
}

rootProject.name = "riddle-boox-spike"
include(":app")
