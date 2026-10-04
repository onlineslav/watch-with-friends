// Native QA fixture only; never packaged into the production app.
#import <AppKit/AppKit.h>
int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSBundle *bundle = NSBundle.mainBundle;
        NSString *marker = [bundle objectForInfoDictionaryKey:@"QAMarker"];
        NSString *version = [bundle objectForInfoDictionaryKey:@"CFBundleVersion"];
        [version writeToFile:[marker stringByAppendingFormat:@"-%@", version] atomically:YES encoding:NSUTF8StringEncoding error:nil];
        [NSApp run];
    }
    return 0;
}
