#import <napi.h>
#import <AppKit/AppKit.h>
#import <dlfcn.h>

// C function pointers loaded from the Swift dylib
typedef void (*SetCallbackFn)(void (*)(const char*, const char*));
typedef void (*AttachFn)(void*);
typedef void (*DetachFn)(void);
typedef void (*UpdateAccountsFn)(const char*);
typedef void (*UpdateInvitesFn)(const char*);
typedef void (*UpdateLabelsFn)(const char*);
typedef void (*RunCustomizationFn)(void);
typedef void (*SetItemEnabledFn)(const char*, bool);
typedef void (*UpdateDockDateFn)(int, const char*, const char*);
typedef void (*UpdateDockSvgFn)(const char*);
typedef void (*SetDockBadgeFn)(const char*);
typedef void (*ReloadWidgetsFn)(void);
typedef char* (*GroupContainerPathFn)(const char*);
typedef char* (*AppGroupIdentifierFn)(void);
typedef char* (*LocalCacheKeyFn)(void);

static SetCallbackFn fn_set_callback = nullptr;
static AttachFn fn_attach = nullptr;
static DetachFn fn_detach = nullptr;
static UpdateAccountsFn fn_update_accounts = nullptr;
static UpdateInvitesFn fn_update_invites = nullptr;
static UpdateLabelsFn fn_update_labels = nullptr;
static RunCustomizationFn fn_run_customization = nullptr;
static SetItemEnabledFn fn_set_item_enabled = nullptr;
static UpdateDockDateFn fn_update_dock_date = nullptr;
static UpdateDockSvgFn fn_update_dock_svg = nullptr;
static SetDockBadgeFn fn_set_dock_badge = nullptr;
static ReloadWidgetsFn fn_reload_widgets = nullptr;
static GroupContainerPathFn fn_group_container_path = nullptr;
static AppGroupIdentifierFn fn_app_group_identifier = nullptr;
static LocalCacheKeyFn fn_local_cache_key = nullptr;
static void* dylibHandle = nullptr;

// JavaScript callback reference (called from Swift via C bridge)
static Napi::ThreadSafeFunction tsfn;

static void actionBridge(const char* action, const char* value) {
  if (tsfn) {
    std::string a(action);
    std::string v(value);
    tsfn.BlockingCall([a, v](Napi::Env env, Napi::Function jsCallback) {
      jsCallback.Call({
        Napi::String::New(env, a),
        Napi::String::New(env, v),
      });
    });
  }
}

static bool loadDylib(Napi::Env env, const std::string& path) {
  if (dylibHandle) return true;

  dylibHandle = dlopen(path.c_str(), RTLD_NOW);
  if (!dylibHandle) {
    Napi::Error::New(env, std::string("Failed to load Magical toolbar dylib: ") + dlerror())
      .ThrowAsJavaScriptException();
    return false;
  }

  fn_set_callback = (SetCallbackFn)dlsym(dylibHandle, "toolbar_set_callback");
  fn_attach = (AttachFn)dlsym(dylibHandle, "toolbar_attach");
  fn_detach = (DetachFn)dlsym(dylibHandle, "toolbar_detach");
  fn_update_accounts = (UpdateAccountsFn)dlsym(dylibHandle, "toolbar_update_accounts");
  fn_update_invites = (UpdateInvitesFn)dlsym(dylibHandle, "toolbar_update_invites");
  fn_update_labels = (UpdateLabelsFn)dlsym(dylibHandle, "toolbar_update_labels");
  fn_run_customization = (RunCustomizationFn)dlsym(dylibHandle, "toolbar_run_customization");
  fn_set_item_enabled = (SetItemEnabledFn)dlsym(dylibHandle, "toolbar_set_item_enabled");
  fn_update_dock_date = (UpdateDockDateFn)dlsym(dylibHandle, "dock_tile_update_date");
  fn_update_dock_svg = (UpdateDockSvgFn)dlsym(dylibHandle, "dock_tile_update_svg");
  fn_set_dock_badge = (SetDockBadgeFn)dlsym(dylibHandle, "dock_tile_set_badge");
  fn_reload_widgets = (ReloadWidgetsFn)dlsym(dylibHandle, "widgets_reload_all");
  fn_group_container_path =
    (GroupContainerPathFn)dlsym(dylibHandle, "widgets_group_container_path");
  fn_app_group_identifier =
    (AppGroupIdentifierFn)dlsym(dylibHandle, "widgets_app_group_identifier");
  fn_local_cache_key = (LocalCacheKeyFn)dlsym(dylibHandle, "localcache_key");

  if (!fn_set_callback || !fn_attach || !fn_detach || !fn_update_accounts) {
    Napi::Error::New(env, "Missing symbols in Magical toolbar dylib").ThrowAsJavaScriptException();
    dlclose(dylibHandle);
    dylibHandle = nullptr;
    return false;
  }

  return true;
}

// JS: init(dylibPath: string, callback: (action, value) => void)
static Napi::Value Init(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "Expected (dylibPath: string, callback: function)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string dylibPath = info[0].As<Napi::String>().Utf8Value();
  if (!loadDylib(env, dylibPath)) return env.Undefined();

  tsfn = Napi::ThreadSafeFunction::New(
    env, info[1].As<Napi::Function>(), "MagicalToolbarAction", 0, 1);

  fn_set_callback(actionBridge);

  return env.Undefined();
}

// JS: attach(nativeWindowHandle: Buffer)
static Napi::Value Attach(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (!fn_attach) {
    Napi::Error::New(env, "Toolbar not initialised").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Expected (nativeWindowHandle: Buffer)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Buffer<void*> buf = info[0].As<Napi::Buffer<void*>>();
  void* nsViewPtr = *reinterpret_cast<void**>(buf.Data());

  fn_attach(nsViewPtr);
  return env.Undefined();
}

// JS: detach()
static Napi::Value Detach(const Napi::CallbackInfo& info) {
  if (fn_detach) fn_detach();
  return info.Env().Undefined();
}

// JS: updateAccounts(json: string)
static Napi::Value UpdateAccounts(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected (json: string)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string json = info[0].As<Napi::String>().Utf8Value();
  if (fn_update_accounts) fn_update_accounts(json.c_str());

  return env.Undefined();
}

// JS: updateInvites(json: string)
static Napi::Value UpdateInvites(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected (json: string)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string json = info[0].As<Napi::String>().Utf8Value();
  if (fn_update_invites) fn_update_invites(json.c_str());

  return env.Undefined();
}

// JS: updateLabels(json: string)
static Napi::Value UpdateLabels(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected (json: string)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string json = info[0].As<Napi::String>().Utf8Value();
  if (fn_update_labels) fn_update_labels(json.c_str());

  return env.Undefined();
}

// JS: runCustomization()
static Napi::Value RunCustomization(const Napi::CallbackInfo& info) {
  if (fn_run_customization) fn_run_customization();
  return info.Env().Undefined();
}

// JS: setItemEnabled(itemId: string, enabled: boolean)
static Napi::Value SetItemEnabled(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsBoolean()) {
    Napi::TypeError::New(env, "Expected (itemId: string, enabled: boolean)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string itemId = info[0].As<Napi::String>().Utf8Value();
  bool enabled = info[1].As<Napi::Boolean>().Value();
  if (fn_set_item_enabled) fn_set_item_enabled(itemId.c_str(), enabled);

  return env.Undefined();
}

// JS: updateDockDate(day: number, month: string, dayOfWeek?: string)
static Napi::Value UpdateDockDate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
    Napi::TypeError::New(env, "Expected (day: number, month: string, [dayOfWeek: string])")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  int day = info[0].As<Napi::Number>().Int32Value();
  std::string month = info[1].As<Napi::String>().Utf8Value();
  std::string dow = (info.Length() >= 3 && info[2].IsString())
    ? info[2].As<Napi::String>().Utf8Value()
    : "";

  if (fn_update_dock_date) {
    fn_update_dock_date(day, month.c_str(), dow.empty() ? nullptr : dow.c_str());
  }

  return env.Undefined();
}

// JS: setDockBadge(badge: string | null)
static Napi::Value SetDockBadge(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1) {
    Napi::TypeError::New(env, "Expected (badge: string | null)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (info[0].IsNull() || info[0].IsUndefined()) {
    if (fn_set_dock_badge) fn_set_dock_badge(nullptr);
  } else if (info[0].IsString()) {
    std::string badge = info[0].As<Napi::String>().Utf8Value();
    if (fn_set_dock_badge) fn_set_dock_badge(badge.c_str());
  }

  return env.Undefined();
}

// JS: updateDockSvg(svgXml: string)
static Napi::Value UpdateDockSvg(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected (svgXml: string)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string svg = info[0].As<Napi::String>().Utf8Value();
  if (fn_update_dock_svg) {
    fn_update_dock_svg(svg.c_str());
  }

  return env.Undefined();
}

// JS: hasApplicationForUrl(url: string) -> boolean
//
// Answered here in Objective-C++ rather than through the Swift dylib: AppKit is already
// linked into the addon, and a LaunchServices lookup needs nothing the dylib holds.
static Napi::Value HasApplicationForUrl(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected (url: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string urlString = info[0].As<Napi::String>().Utf8Value();
  // LaunchServices logs a CoreFoundation warning for a URL carrying no scheme, so a string
  // that is not a URL is answered here rather than passed on.
  NSURL* url = [NSURL URLWithString:[NSString stringWithUTF8String:urlString.c_str()]];
  if (!url || !url.scheme) return Napi::Boolean::New(env, false);

  NSURL* application = [[NSWorkspace sharedWorkspace] URLForApplicationToOpenURL:url];
  return Napi::Boolean::New(env, application != nil);
}

// JS: reloadWidgets()
// WidgetCenter works out which widgets to reload from the calling process's
// bundle identity, and BaseBoard verifies that the process executable matches
// CFBundleExecutable in Info.plist. Only the Electron main process qualifies.
static Napi::Value ReloadWidgets(const Napi::CallbackInfo& info) {
  if (fn_reload_widgets) fn_reload_widgets();
  return info.Env().Undefined();
}

// JS: appGroupIdentifier() -> string | null
// The App Group this build is entitled for, read out of its own signature. The
// team prefix is only known to the certificate that signed the app, so asking
// the signature is what lets a build on any Apple ID find its container.
// Returns null on an unsigned or ad-hoc build, which carries no entitlements.
static Napi::Value AppGroupIdentifier(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!fn_app_group_identifier) return env.Null();

  char* groupId = fn_app_group_identifier();
  if (!groupId) return env.Null();

  Napi::Value result = Napi::String::New(env, groupId);
  free(groupId);  // strdup'd on the Swift side
  return result;
}

// JS: groupContainerPath(groupId) -> string | null
// Creating the container is the point, not just resolving a path: only
// containermanagerd makes a directory the sandboxed extension can open, and it
// does that in response to this call. Returns null when the process carries no
// entitlement for the group.
static Napi::Value GroupContainerPath(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!fn_group_container_path || info.Length() < 1 || !info[0].IsString()) {
    return env.Null();
  }

  std::string groupId = info[0].As<Napi::String>().Utf8Value();
  char* path = fn_group_container_path(groupId.c_str());
  if (!path) return env.Null();

  Napi::Value result = Napi::String::New(env, path);
  free(path);
  return result;
}

// JS: localCacheKey() -> string | null
// The base64 of the 32-byte key the local cache files are encrypted under,
// created in the keychain on first use. Base64 because the key is random bytes
// and a C string stops at the first NUL. Returns null on a build that carries
// no keychain access group, which is every unsigned or ad-hoc one.
static Napi::Value LocalCacheKey(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!fn_local_cache_key) return env.Null();

  char* keyBase64 = fn_local_cache_key();
  if (!keyBase64) return env.Null();

  Napi::Value result = Napi::String::New(env, keyBase64);
  free(keyBase64);  // strdup'd on the Swift side
  return result;
}

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  exports.Set("init", Napi::Function::New(env, Init));
  exports.Set("attach", Napi::Function::New(env, Attach));
  exports.Set("detach", Napi::Function::New(env, Detach));
  exports.Set("updateAccounts", Napi::Function::New(env, UpdateAccounts));
  exports.Set("updateInvites", Napi::Function::New(env, UpdateInvites));
  exports.Set("updateLabels", Napi::Function::New(env, UpdateLabels));
  exports.Set("runCustomization", Napi::Function::New(env, RunCustomization));
  exports.Set("setItemEnabled", Napi::Function::New(env, SetItemEnabled));
  exports.Set("updateDockDate", Napi::Function::New(env, UpdateDockDate));
  exports.Set("updateDockSvg", Napi::Function::New(env, UpdateDockSvg));
  exports.Set("setDockBadge", Napi::Function::New(env, SetDockBadge));
  exports.Set("hasApplicationForUrl", Napi::Function::New(env, HasApplicationForUrl));
  exports.Set("reloadWidgets", Napi::Function::New(env, ReloadWidgets));
  exports.Set("groupContainerPath", Napi::Function::New(env, GroupContainerPath));
  exports.Set("appGroupIdentifier", Napi::Function::New(env, AppGroupIdentifier));
  exports.Set("localCacheKey", Napi::Function::New(env, LocalCacheKey));
  return exports;
}

NODE_API_MODULE(magical_addon, InitAll)
