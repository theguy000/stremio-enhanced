{
  "targets": [
    {
      "target_name": "mpv_native",
      "sources": [
        "src/addon.cpp",
        "src/mpv_instance.cpp",
        "src/mpv_events.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "include"
      ],
      "defines": ["NAPI_VERSION=8", "NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/platform/window_win32.cpp"],
          "libraries": [
            "-l<(module_root_dir)/../../static/mpv/win/libmpv-2.lib",
            "-luser32.lib"
          ],
          "copies": [{
            "destination": "<(PRODUCT_DIR)",
            "files": ["<(module_root_dir)/../../static/mpv/win/libmpv-2.dll"]
          }]
        }],
        ["OS=='mac'", {
          "sources": ["src/platform/window_macos.mm"],
          "libraries": [
            "-L<(module_root_dir)/../../static/mpv/mac-<(target_arch)",
            "-lmpv",
            "-framework Cocoa"
          ],
          "xcode_settings": {
            "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-ObjC++"],
            "MACOSX_DEPLOYMENT_TARGET": "10.15"
          }
        }],
        ["OS=='linux'", {
          "sources": ["src/platform/window_linux.cpp"],
          "libraries": [
            "-L<(module_root_dir)/../../static/mpv/linux-x64",
            "-lmpv",
            "-lX11"
          ],
          "cflags_cc": ["-std=c++17"]
        }]
      ],
      "cflags_cc": ["-std=c++17"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++17"]
        }
      }
    }
  ]
}
