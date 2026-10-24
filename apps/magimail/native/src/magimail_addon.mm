#import <napi.h>
#import <AppKit/AppKit.h>
#import <dlfcn.h>
#import <os/log.h>
#include <memory>

static os_log_t MagimailAddonLog() {
  static os_log_t logger = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    logger = os_log_create("com.alexhaslam.magimail", "NativeToolbar");
  });
  return logger;
}

// C function pointers loaded from the Swift dylib
typedef void (*SetCallbackFn)(void (*)(const char*, const char*));
typedef void (*AttachFn)(void*);
typedef void (*DetachFn)(void);
typedef void (*UpdateAccountsFn)(const char*);
typedef void (*UpdateLabelsFn)(const char*);
typedef void (*RunCustomizationFn)(void);
typedef void (*SetItemEnabledFn)(const char*, bool);
typedef void (*SetShareUrlFn)(const char*);
typedef void (*ReloadWidgetsFn)(void);
typedef char* (*GroupContainerPathFn)(const char*);
typedef char* (*AppGroupIdentifierFn)(void);
typedef char* (*LocalCacheKeyFn)(void);

static SetCallbackFn fn_set_callback = nullptr;
static AttachFn fn_attach = nullptr;
static DetachFn fn_detach = nullptr;
static UpdateAccountsFn fn_update_accounts = nullptr;
static UpdateLabelsFn fn_update_labels = nullptr;
static RunCustomizationFn fn_run_customization = nullptr;
static SetItemEnabledFn fn_set_item_enabled = nullptr;
static SetShareUrlFn fn_set_share_url = nullptr;
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
    Napi::Error::New(env, std::string("Failed to load toolbar dylib: ") + dlerror())
      .ThrowAsJavaScriptException();
    return false;
  }

  fn_set_callback = (SetCallbackFn)dlsym(dylibHandle, "toolbar_set_callback");
  fn_attach = (AttachFn)dlsym(dylibHandle, "toolbar_attach");
  fn_detach = (DetachFn)dlsym(dylibHandle, "toolbar_detach");
  fn_update_accounts = (UpdateAccountsFn)dlsym(dylibHandle, "toolbar_update_accounts");
  fn_update_labels = (UpdateLabelsFn)dlsym(dylibHandle, "toolbar_update_labels");
  fn_run_customization = (RunCustomizationFn)dlsym(dylibHandle, "toolbar_run_customization");
  fn_set_item_enabled = (SetItemEnabledFn)dlsym(dylibHandle, "toolbar_set_item_enabled");
  fn_set_share_url = (SetShareUrlFn)dlsym(dylibHandle, "toolbar_set_share_url");
  fn_reload_widgets = (ReloadWidgetsFn)dlsym(dylibHandle, "widgets_reload_all");
  fn_group_container_path =
    (GroupContainerPathFn)dlsym(dylibHandle, "widgets_group_container_path");
  fn_app_group_identifier =
    (AppGroupIdentifierFn)dlsym(dylibHandle, "widgets_app_group_identifier");
  fn_local_cache_key = (LocalCacheKeyFn)dlsym(dylibHandle, "localcache_key");

  if (!fn_set_callback || !fn_attach || !fn_detach || !fn_update_accounts) {
    Napi::Error::New(env, "Missing symbols in toolbar dylib").ThrowAsJavaScriptException();
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

  // Create thread-safe function for callbacks from Swift
  tsfn = Napi::ThreadSafeFunction::New(
    env, info[1].As<Napi::Function>(), "ToolbarAction", 0, 1);

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

// JS: setShareUrl(url: string)
// The native share picker asks for its items synchronously, so the link has to
// be pushed across before the user clicks it.
static Napi::Value SetShareUrl(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected (url: string)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string url = info[0].As<Napi::String>().Utf8Value();
  if (fn_set_share_url) fn_set_share_url(url.c_str());

  return env.Undefined();
}

// JS: reloadWidgets()
// WidgetCenter works out which widgets to reload from the calling process's
// bundle identity and BaseBoard verifies that the process executable matches
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
  free(path);  // strdup'd on the Swift side
  return result;
}

// Mock NSDraggingInfo for programmatic drops
@interface MagimailDragInfo : NSObject <NSDraggingInfo>
@property (nonatomic, strong) NSPasteboard* pboard;
@property (nonatomic, assign) NSPoint location;
@property (nonatomic, weak) NSWindow* targetWindow;
@property (nonatomic, weak) NSView* targetView;
@end

@implementation MagimailDragInfo
@synthesize draggingSourceOperationMask = _draggingSourceOperationMask;
@synthesize animatesToDestination = _animatesToDestination;
@synthesize numberOfValidItemsForDrop = _numberOfValidItemsForDrop;
@synthesize draggingFormation = _draggingFormation;
@synthesize springLoadingHighlight = _springLoadingHighlight;

- (instancetype)initWithPasteboard:(NSPasteboard*)pb location:(NSPoint)loc window:(NSWindow*)win view:(NSView*)view {
  self = [super init];
  if (self) {
    _pboard = pb;
    _location = loc;
    _targetWindow = win;
    _targetView = view;
    _draggingSourceOperationMask = NSDragOperationCopy;
    NSArray* urls = [pb readObjectsForClasses:@[[NSURL class]] options:nil];
    _numberOfValidItemsForDrop = urls.count > 0 ? urls.count : 1;
  }
  return self;
}

- (NSWindow*)draggingDestinationWindow { return _targetWindow; }
- (NSDragOperation)draggingSourceOperationMask { return NSDragOperationCopy; }
- (NSPoint)draggingLocation {
  // Chromium expects this in window coordinates
  return _location;
}
- (NSPoint)draggedImageLocation { return _location; }
- (NSImage*)draggedImage { return [[NSImage alloc] initWithSize:NSMakeSize(1, 1)]; }
- (NSPasteboard*)draggingPasteboard { return _pboard; }
- (id)draggingSource { return nil; }
- (NSInteger)draggingSequenceNumber { return 0; }
- (void)slideDraggedImageTo:(NSPoint)p { _location = p; }
- (NSArray<NSString*>*)namesOfPromisedFilesDroppedAtDestination:(NSURL*)d { return @[]; }
- (void)enumerateDraggingItemsWithOptions:(NSDraggingItemEnumerationOptions)options
  forView:(NSView*)view
  classes:(NSArray<Class>*)classes
  searchOptions:(NSDictionary<NSPasteboardReadingOptionKey,id>*)opts
  usingBlock:(void(^)(NSDraggingItem*, NSInteger, BOOL*))block {
  NSArray* objects = nil;
  if (classes && classes.count > 0) {
    objects = [_pboard readObjectsForClasses:classes options:opts];
  }
  if (!objects || objects.count == 0) {
    objects = [_pboard readObjectsForClasses:@[[NSURL class]] options:nil];
  }
  NSInteger idx = 0;
  for (id obj in objects) {
    id<NSPasteboardWriting> writer = nil;
    if ([obj conformsToProtocol:@protocol(NSPasteboardWriting)]) {
      writer = (id<NSPasteboardWriting>)obj;
    }
    if (!writer) continue;
    NSDraggingItem* item = [[NSDraggingItem alloc] initWithPasteboardWriter:writer];
    BOOL stop = NO;
    block(item, idx++, &stop);
    if (stop) break;
  }
}
- (void)resetSpringLoading {}

// Private methods that Chromium's RenderWidgetHostViewCocoa calls
- (NSDragOperation)_lastDragDestinationOperation { return NSDragOperationCopy; }
- (void)_setLastDragDestinationOperation:(NSDragOperation)op {}
@end

// JS: dropFiles(nativeWindowHandle: Buffer, filePaths: string[])
// Programmatically drops files onto the webview via NSDraggingDestination,
// producing trusted drag events that Gmail accepts.
static Napi::Value DropFiles(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsArray()) {
    Napi::TypeError::New(env, "Expected (nativeWindowHandle: Buffer, filePaths: string[])")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Buffer<void*> buf = info[0].As<Napi::Buffer<void*>>();
  void* nsViewPtr = *reinterpret_cast<void**>(buf.Data());
  NSView* contentView = (__bridge NSView*)nsViewPtr;
  NSWindow* window = contentView.window;
  if (!window) {
    Napi::Error::New(env, "No window found for handle").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Array pathsArray = info[1].As<Napi::Array>();
  NSMutableArray<NSURL*>* fileURLs = [NSMutableArray array];
  for (uint32_t i = 0; i < pathsArray.Length(); i++) {
    std::string p = pathsArray.Get(i).As<Napi::String>().Utf8Value();
    NSURL* url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:p.c_str()]];
    if (url) [fileURLs addObject:url];
  }

  if (fileURLs.count == 0) return env.Undefined();

  dispatch_async(dispatch_get_main_queue(), ^{
    // Find candidate views in the hierarchy:
    // In Chromium on macOS, WebContentsViewCocoa implements <NSDraggingDestination>
    // and delegates to WebDragDestMac. RenderWidgetHostViewCocoa is its child.
    __block __weak void (^weakCollectViews)(NSView*, NSMutableArray<NSView*>*);
    void (^collectViews)(NSView*, NSMutableArray<NSView*>*);
    weakCollectViews = collectViews = ^(NSView* v, NSMutableArray<NSView*>* list) {
      if ([v respondsToSelector:@selector(draggingEntered:)]) {
        [list addObject:v];
      }
      for (NSView* sub in v.subviews) {
        weakCollectViews(sub, list);
      }
    };

    NSMutableArray<NSView*>* candidates = [NSMutableArray array];
    collectViews(contentView, candidates);

    for (NSView* v in candidates) {
      os_log_debug(MagimailAddonLog(), "Candidate drag view: %{public}@ (bounds: %{public}@)",
                   NSStringFromClass([v class]), NSStringFromRect(v.bounds));
    }

    __block NSView* targetView = nil;
    for (NSView* v in candidates) {
      NSString* cls = NSStringFromClass([v class]);
      if ([cls containsString:@"WebContentsView"]) {
        targetView = v;
        break;
      }
    }
    if (!targetView) {
      for (NSView* v in candidates) {
        NSString* cls = NSStringFromClass([v class]);
        if ([cls containsString:@"RenderWidgetHostView"]) {
          targetView = v;
          break;
        }
      }
    }
    if (!targetView && candidates.count > 0) {
      targetView = candidates.firstObject;
    }
    if (!targetView) targetView = contentView;

    os_log_info(MagimailAddonLog(), "Selected drag view: %{public}@ (bounds: %{public}@)",
                NSStringFromClass([targetView class]), NSStringFromRect(targetView.bounds));

    [NSApp activateIgnoringOtherApps:YES];
    [window makeKeyAndOrderFront:nil];
    if (targetView) {
      [window makeFirstResponder:targetView];
    }

    // Create pasteboard with file URLs — use standard NSDragPboard
    NSPasteboard* pboard = [NSPasteboard pasteboardWithName:NSPasteboardNameDrag];
    [pboard clearContents];
    [pboard writeObjects:fileURLs];
    // Also write legacy NSFilenamesPboardType for compatibility
    NSMutableArray<NSString*>* paths = [NSMutableArray array];
    for (NSURL* url in fileURLs) {
      if (url.path) [paths addObject:url.path];
    }
    #pragma clang diagnostic push
    #pragma clang diagnostic ignored "-Wdeprecated-declarations"
    [pboard setPropertyList:paths forType:NSFilenamesPboardType];
    #pragma clang diagnostic pop

    // Drop point: centre of the target view, in window coordinates
    NSPoint centreInView = NSMakePoint(NSMidX(targetView.bounds), NSMidY(targetView.bounds));
    NSPoint centreInWindow = [targetView convertPoint:centreInView toView:nil];

    MagimailDragInfo* dragInfo = [[MagimailDragInfo alloc]
      initWithPasteboard:pboard location:centreInWindow window:window view:targetView];

    // Call NSDraggingDestination protocol methods with delays between
    // to let Chromium process each drag state transition
    @try {
      NSDragOperation op = 0;
      if ([targetView respondsToSelector:@selector(draggingEntered:)]) {
        op = [targetView draggingEntered:dragInfo];
        os_log_info(MagimailAddonLog(), "draggingEntered on %{public}@: op=%lu",
                    NSStringFromClass([targetView class]), (unsigned long)op);
      }

      // If the primary view returned 0, try other candidates in the hierarchy
      if (op == 0) {
        for (NSView* alt in candidates) {
          if (alt == targetView) continue;
          NSDragOperation altOp = [alt draggingEntered:dragInfo];
          os_log_info(MagimailAddonLog(), "draggingEntered on alternative %{public}@: op=%lu",
                      NSStringFromClass([alt class]), (unsigned long)altOp);
          if (altOp != 0) {
            targetView = alt;
            op = altOp;
            break;
          }
        }
      }

      // Chromium needs a brief moment to relay drag enter IPC to the renderer process
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        if ([targetView respondsToSelector:@selector(draggingUpdated:)]) {
          [targetView draggingUpdated:dragInfo];
        }

        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
          if ([targetView respondsToSelector:@selector(prepareForDragOperation:)]) {
            [targetView prepareForDragOperation:dragInfo];
          }

          if ([targetView respondsToSelector:@selector(performDragOperation:)]) {
            BOOL result = [targetView performDragOperation:dragInfo];
            os_log_info(MagimailAddonLog(), "performDragOperation: %s", result ? "YES" : "NO");

            if (result && [targetView respondsToSelector:@selector(concludeDragOperation:)]) {
              [targetView concludeDragOperation:dragInfo];
            }

            if ([targetView respondsToSelector:@selector(draggingEnded:)]) {
              [targetView draggingEnded:dragInfo];
            }
          }
        });
      });
    } @catch (NSException* ex) {
      os_log_error(MagimailAddonLog(), "Drop failed: %{public}@", ex);
    }
  });

  return env.Undefined();
}

// Sharing picker delegate: retains the picker while its sheet is up, then stands in as
// the chosen service's delegate so the caller is told when the service has finished with
// the items. A shared thread is a PDF in a temp directory, and the caller cannot remove
// it until whatever is uploading it has read it.
//
// One delegate per picker rather than one shared instance, because two pickers in flight
// would otherwise share a single completion and the first to finish would answer for both.
@interface MagimailSharingDelegate : NSObject <NSSharingServicePickerDelegate, NSSharingServiceDelegate>
@property (nonatomic, strong) NSSharingServicePicker* activePicker;
@property (nonatomic, copy) void (^completion)(void);
- (void)finish;
@end

// Holds each delegate alive from the moment its picker opens until its service reports.
static NSMutableSet<MagimailSharingDelegate*>* gSharingDelegates = nil;

@implementation MagimailSharingDelegate
- (void)finish {
  // The set holds the only strong reference, so keep one here across the removal.
  MagimailSharingDelegate* keepAlive = self;
  void (^block)(void) = keepAlive.completion;
  keepAlive.completion = nil;
  keepAlive.activePicker = nil;
  if (block) block();
  [gSharingDelegates removeObject:keepAlive];
}

- (id<NSSharingServiceDelegate>)sharingServicePicker:(NSSharingServicePicker *)sharingServicePicker
                           delegateForSharingService:(NSSharingService *)sharingService {
  return self;
}

- (void)sharingServicePicker:(NSSharingServicePicker *)sharingServicePicker didChooseSharingService:(NSSharingService *)sharingService {
  // A nil service means the sheet closed without a choice, so nothing will read the
  // items and the caller can have them back now.
  if (!sharingService) [self finish];
}

- (void)sharingService:(NSSharingService *)sharingService didShareItems:(NSArray *)items {
  [self finish];
}

- (void)sharingService:(NSSharingService *)sharingService didFailToShareItems:(NSArray *)items error:(NSError *)error {
  [self finish];
}
@end

// JS: showSharingPicker(nativeWindowHandle: Buffer, items: string[], onFinished?: () => void)
static Napi::Value ShowSharingPicker(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsArray()) {
    Napi::TypeError::New(env, "Expected (nativeWindowHandle: Buffer, items: string[])")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Fires once the chosen service has read the items, or once the sheet closes with
  // nothing chosen. Unref'd, so a picker the user walks away from cannot keep the
  // process alive.
  std::shared_ptr<Napi::ThreadSafeFunction> tsfn;
  if (info.Length() >= 3 && info[2].IsFunction()) {
    tsfn = std::make_shared<Napi::ThreadSafeFunction>(Napi::ThreadSafeFunction::New(
      env, info[2].As<Napi::Function>(), "MagimailSharingCompletion", 0, 1));
    tsfn->Unref(env);
  }

  void (^completion)(void) = nil;
  if (tsfn) {
    completion = ^{
      tsfn->NonBlockingCall([](Napi::Env, Napi::Function jsCallback) { jsCallback.Call({}); });
      tsfn->Release();
    };
  }

  Napi::Buffer<void*> buf = info[0].As<Napi::Buffer<void*>>();
  void* nsViewPtr = *reinterpret_cast<void**>(buf.Data());
  NSView* contentView = (__bridge NSView*)nsViewPtr;
  NSWindow* window = contentView.window;
  if (!window) {
    if (completion) completion();
    return env.Undefined();
  }

  Napi::Array pathsArray = info[1].As<Napi::Array>();
  NSMutableArray* shareItems = [NSMutableArray array];
  for (uint32_t i = 0; i < pathsArray.Length(); i++) {
    Napi::Value v = pathsArray.Get(i);
    if (v.IsString()) {
      std::string s = v.As<Napi::String>().Utf8Value();
      NSString* nsStr = [NSString stringWithUTF8String:s.c_str()];
      if ([nsStr hasPrefix:@"http://"] || [nsStr hasPrefix:@"https://"]) {
        NSURL* url = [NSURL URLWithString:nsStr];
        if (url) [shareItems addObject:url];
      } else if ([nsStr hasPrefix:@"/"] || [nsStr hasPrefix:@"file://"]) {
        NSURL* url = [nsStr hasPrefix:@"file://"]
          ? [NSURL URLWithString:nsStr]
          : [NSURL fileURLWithPath:nsStr];
        if (url) [shareItems addObject:url];
      } else {
        [shareItems addObject:nsStr];
      }
    }
  }

  if (shareItems.count == 0) {
    if (completion) completion();
    return env.Undefined();
  }

  dispatch_async(dispatch_get_main_queue(), ^{
    if (!gSharingDelegates) {
      gSharingDelegates = [NSMutableSet set];
    }
    MagimailSharingDelegate* delegate = [[MagimailSharingDelegate alloc] init];
    delegate.completion = completion;
    [gSharingDelegates addObject:delegate];

    NSSharingServicePicker* picker = [[NSSharingServicePicker alloc] initWithItems:shareItems];
    picker.delegate = delegate;
    delegate.activePicker = picker;

    NSPoint screenLoc = [NSEvent mouseLocation];
    NSRect screenRect = NSMakeRect(screenLoc.x, screenLoc.y, 1, 1);
    NSRect windowRect = [window convertRectFromScreen:screenRect];
    NSPoint viewPoint = [contentView convertPoint:windowRect.origin fromView:nil];
    NSRect anchorRect;
    if (NSPointInRect(viewPoint, contentView.bounds)) {
      anchorRect = NSMakeRect(viewPoint.x, viewPoint.y, 1, 1);
    } else {
      anchorRect = NSMakeRect(contentView.bounds.size.width - 150, contentView.bounds.size.height - 10, 1, 1);
    }

    [picker showRelativeToRect:anchorRect ofView:contentView preferredEdge:NSRectEdgeMinY];
  });

  return env.Undefined();
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

// Module registration
static Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("init", Napi::Function::New(env, Init));
  exports.Set("attach", Napi::Function::New(env, Attach));
  exports.Set("detach", Napi::Function::New(env, Detach));
  exports.Set("updateAccounts", Napi::Function::New(env, UpdateAccounts));
  exports.Set("updateLabels", Napi::Function::New(env, UpdateLabels));
  exports.Set("runCustomization", Napi::Function::New(env, RunCustomization));
  exports.Set("setItemEnabled", Napi::Function::New(env, SetItemEnabled));
  exports.Set("setShareUrl", Napi::Function::New(env, SetShareUrl));
  exports.Set("dropFiles", Napi::Function::New(env, DropFiles));
  exports.Set("groupContainerPath", Napi::Function::New(env, GroupContainerPath));
  exports.Set("appGroupIdentifier", Napi::Function::New(env, AppGroupIdentifier));
  exports.Set("localCacheKey", Napi::Function::New(env, LocalCacheKey));
  exports.Set("showSharingPicker", Napi::Function::New(env, ShowSharingPicker));
  exports.Set("reloadWidgets", Napi::Function::New(env, ReloadWidgets));
  return exports;
}

NODE_API_MODULE(magimail_addon, InitModule)
