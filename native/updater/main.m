// Sparkle verifies signatures, extracts, replaces and relaunches. Electron alone
// grants the final restart over a private stdin pipe. No Apple membership needed.
#import <AppKit/AppKit.h>
#import <Sparkle/Sparkle.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>

static void emit(NSString *phase, NSDictionary *fields) {
    NSMutableDictionary *event = [NSMutableDictionary dictionaryWithDictionary:fields ?: @{}];
    event[@"phase"] = phase;
    NSData *json = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}
@interface UpdateDriver : NSObject <SPUUserDriver, SPUUpdaterDelegate>
@property(nonatomic, strong) SPUUpdater *updater;
@property(nonatomic, copy) NSString *feed;
@property(nonatomic, copy) NSString *version;
@property(nonatomic, copy) void (^installHandler)(SPUUserUpdateChoice);
@property(nonatomic) uint64_t received;
@property(nonatomic) uint64_t expected;
@property(nonatomic) NSInteger lastProgress;
@property(nonatomic) BOOL installing;
@end
@implementation UpdateDriver
- (BOOL)updaterShouldPromptForPermissionToCheckForUpdates:(SPUUpdater *)updater { return NO; }
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater { return self.feed; }
- (BOOL)updater:(SPUUpdater *)updater shouldDownloadReleaseNotesForUpdate:(SUAppcastItem *)item { return NO; }
- (BOOL)updater:(SPUUpdater *)updater shouldProceedWithUpdate:(SUAppcastItem *)item updateCheck:(SPUUpdateCheck)check error:(NSError **)error {
    fprintf(stderr, "Evaluating update %s\n", item.versionString.UTF8String);
    if (item.informationOnlyUpdate || item.majorUpgrade || ![item.installationType isEqualToString:@"application"]) {
        if (error) *error = [NSError errorWithDomain:@"WatchWithFriendsUpdater" code:1 userInfo:@{NSLocalizedDescriptionKey: @"This release cannot be installed automatically."}];
        return NO;
    }
    return YES;
}
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
    reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation { emit(@"checking", nil); }
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
    self.version = item.displayVersionString;
    if (state.stage == SPUUserUpdateStageInstalling) {
        self.installHandler = reply;
        emit(@"ready", @{@"version": self.version});
    } else {
        emit(@"downloading", @{@"version": self.version, @"progress": @0});
        reply(SPUUserUpdateChoiceInstall);
    }
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)data {}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {}
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))ack { emit(@"current", nil); ack(); }
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))ack {
    emit(@"error", @{@"message": error.localizedDescription}); ack();
}
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation { self.received = 0; self.lastProgress = -1; }
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)length { self.expected = length; }
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {
    self.received += length;
    NSInteger progress = self.expected ? MIN(100, (NSInteger)(100.0 * self.received / self.expected)) : 0;
    if (progress != self.lastProgress) {
        self.lastProgress = progress;
        emit(@"downloading", @{@"version": self.version ?: @"", @"progress": @(progress)});
    }
}
- (void)showDownloadDidStartExtractingUpdate { emit(@"extracting", @{@"version": self.version ?: @""}); }
- (void)showExtractionReceivedProgress:(double)progress {}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
    self.installHandler = reply;
    emit(@"ready", @{@"version": self.version ?: @""});
}
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated retryTerminatingApplication:(void (^)(void))retry {
    emit(@"installing", @{@"version": self.version ?: @""});
}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))ack {
    emit(@"installed", @{@"relaunched": @(relaunched)}); ack();
}
- (void)dismissUpdateInstallation { self.installHandler = nil; }
- (void)updater:(SPUUpdater *)updater didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check error:(NSError *)error {
    if (error && error.code != SUNoUpdateError) {
        emit(@"error", @{@"message": error.localizedDescription}); exit(1);
    }
    emit(@"current", nil); exit(0);
}
- (void)command:(NSString *)command {
    if ([command isEqualToString:@"install"] && self.installHandler && !self.installing) {
        self.installing = YES;
        void (^reply)(SPUUserUpdateChoice) = self.installHandler;
        self.installHandler = nil;
        reply(SPUUserUpdateChoiceInstall);
    }
}
- (void)parentClosed {
    if (self.installing) return; // installer connection survives the app's quit
    if (self.installHandler) {
        void (^reply)(SPUUserUpdateChoice) = self.installHandler;
        self.installHandler = nil;
        reply(SPUUserUpdateChoiceDismiss); // install on the app's ordinary quit
    } else exit(0);
}
@end

int main(int argc, const char **argv) {
    @autoreleasepool {
        signal(SIGPIPE, SIG_IGN);
        if (argc < 2 || argc > 3 || geteuid() == 0) return 2;
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSString *bundlePath = [[NSString stringWithUTF8String:argv[1]] stringByResolvingSymlinksInPath];
        NSBundle *bundle = [NSBundle bundleWithPath:bundlePath];
        if (!bundle || ![bundlePath.pathExtension isEqualToString:@"app"]) return 2;
        NSFileManager *files = NSFileManager.defaultManager;
        if ([bundlePath hasPrefix:@"/Volumes/"] || [bundlePath containsString:@"/AppTranslocation/"] ||
            ![files isWritableFileAtPath:bundlePath] || ![files isWritableFileAtPath:bundlePath.stringByDeletingLastPathComponent]) {
            emit(@"blocked", @{@"message": @"Move the app to a writable Applications folder before updating."}); return 3;
        }
        UpdateDriver *driver = [UpdateDriver new];
        // The optional override is for native fixture tests; production always
        // reads the signed app's Info.plist, never a URL from Electron's renderer.
        driver.feed = argc == 3 ? [NSString stringWithUTF8String:argv[2]] : [bundle objectForInfoDictionaryKey:@"SUFeedURL"];
        driver.updater = [[SPUUpdater alloc] initWithHostBundle:bundle applicationBundle:bundle userDriver:driver delegate:driver];
        driver.updater.userAgentString = @"WatchWithFriendsUpdater";
        driver.updater.automaticallyChecksForUpdates = NO;
        driver.updater.automaticallyDownloadsUpdates = NO;
        driver.updater.sendsSystemProfile = NO;
        NSError *error = nil;
        if (![driver.updater startUpdater:&error]) { emit(@"error", @{@"message": error.localizedDescription}); return 1; }
        [driver.updater checkForUpdates];
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            // Do not use fgets(stdin): Apple's XQuery parser calls fileno(stdin)
            // while parsing the feed. A blocked fgets holds stdin's FILE lock
            // and deadlocks the main thread. POSIX read owns no stdio lock.
            char buffer[256], line[128];
            size_t used = 0;
            BOOL discard = NO;
            for (;;) {
                ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
                if (count < 0 && errno == EINTR) continue;
                if (count <= 0) break;
                for (ssize_t index = 0; index < count; index++) {
                    if (buffer[index] == '\n') {
                        if (!discard) {
                            NSString *command = [[NSString alloc] initWithBytes:line length:used encoding:NSUTF8StringEncoding];
                            if (command) dispatch_async(dispatch_get_main_queue(), ^{ [driver command:command]; });
                        }
                        used = 0; discard = NO;
                    } else if (used < sizeof(line) - 1) line[used++] = buffer[index];
                    else discard = YES;
                }
            }
            dispatch_async(dispatch_get_main_queue(), ^{ [driver parentClosed]; });
        });
        // AppKit also services Sparkle's application lifecycle callbacks.
        [NSApp run];
    }
    return 0;
}
