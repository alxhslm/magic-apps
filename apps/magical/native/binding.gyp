{
  "targets": [
    {
      "target_name": "magical_addon",
      "sources": ["src/magical_addon.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-ObjC++"],
        "MACOSX_DEPLOYMENT_TARGET": "14.0"
      },
      "link_settings": {
        "libraries": [
          "-framework AppKit",
          "-framework Foundation"
        ]
      }
    }
  ]
}
