{
  "targets": [{
    "target_name": "node_libmpv",
    "sources": [
      "src/mpv_player.cpp"
    ],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")",
      "deps",
      "deps/<(OS)-<(target_arch)"
    ],
    "defines": ["NAPI_VERSION=8", "NAPI_DISABLE_CPP_EXCEPTIONS"],
    "conditions": [
      ["OS=='win'", {
        "sources": ["src/gl_context_wgl.cpp"],
        "libraries": ["-lopengl32", "-lgdi32"],
        "msvs_settings": {
          "VCCLCompilerTool": {
            "AdditionalOptions": ["/std:c++17"]
          }
        }
      }],
      ["OS=='linux'", {
        "sources": ["src/gl_context_egl.cpp"],
        "libraries": ["-lEGL", "-lGLESv2", "-ldl"],
        "cflags_cc": ["-std=c++17", "-fPIC"]
      }],
      ["OS=='mac'", {
        "sources": ["src/gl_context_cgl.cpp"],
        "libraries": ["-framework OpenGL", "-framework CoreFoundation"],
        "xcode_settings": {
          "CLANG_CXX_LANGUAGE_STANDARD": "c++17"
        }
      }]
    ]
  }]
}
