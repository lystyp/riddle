plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.riddle.booxspike"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.riddle.booxspike"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        jniLibs {
            pickFirsts += "lib/*/libc++_shared.so"
        }
    }
}

dependencies {
    // EpdController + UpdateMode live here; pulls onyxsdk-base transitively.
    implementation("com.onyx.android.sdk:onyxsdk-device:1.3.5")
    // TouchHelper raw drawing (hardware stroke preview). Maven pulls the full
    // dep chain (penbrush = NeoPen classes, baselite = TouchPoint base) —
    // EinkDraw's "stub AAR" pothole only bites local-file dependencies.
    implementation("com.onyx.android.sdk:onyxsdk-pen:1.5.4")
    // TouchHelper's RxManager needs these at runtime.
    implementation("io.reactivex.rxjava2:rxjava:2.2.21")
    implementation("io.reactivex.rxjava2:rxandroid:2.1.1")
    // The oracle: streamed OpenAI-compatible chat completions.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // The Onyx SDK touches hidden Android APIs on P+.
    implementation("org.lsposed.hiddenapibypass:hiddenapibypass:4.3")

    testImplementation("junit:junit:4.13.2")
    // Real org.json for JVM unit tests (android.jar ships throwing stubs).
    testImplementation("org.json:json:20231013")
}
