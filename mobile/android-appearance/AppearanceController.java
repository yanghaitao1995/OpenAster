// SPDX-License-Identifier: Apache-2.0
package org.openaster.preview;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.view.View;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/** Color-only coordination; Capacitor remains the sole owner of inset/IME layout. */
final class AppearanceController {
    private static final String PREFERENCES = "openaster_appearance";
    private static final String KEY = "theme";

    private AppearanceController() {}

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    static boolean store(Context context, String theme) {
        AppearanceTheme.requireTheme(theme);
        // Called on Capacitor's plugin thread, before resolving the JS call.
        // The only persisted value is the validated enum mirror.
        return preferences(context).edit().putString(KEY, theme).commit();
    }

    @SuppressWarnings("deprecation")
    static void apply(MainActivity activity) {
        if (activity.isFinishing() || activity.isDestroyed()) return;
        // Read at execution time: an earlier lifecycle post cannot restore an old theme.
        String theme = AppearanceTheme.savedTheme(preferences(activity).getAll().get(KEY));
        boolean dark = "dark".equals(theme);
        int background = AppearanceTheme.background(theme);
        // SystemBars reads windowBackground when it reapplies its own style.
        activity.getTheme().applyStyle(dark ? R.style.OpenAsterAppearanceDark : R.style.OpenAsterAppearanceLight, true);
        Window window = activity.getWindow();
        View decor = window.getDecorView();
        decor.setBackgroundColor(background);
        if (activity.getBridge() != null && activity.getBridge().getWebView() != null) {
            activity.getBridge().getWebView().setBackgroundColor(background);
        }
        // On edge-to-edge Android these may be transparent/ignored; the decor
        // background above supplies the color behind Capacitor's unchanged insets.
        window.setStatusBarColor(background);
        // Before API 26 Android has no dark navigation icons. Keep a fixed dark
        // navigation surface there instead of placing white icons on white.
        window.setNavigationBarColor(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? background : 0xff1c1c1e);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) window.setNavigationBarDividerColor(background);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
        controller.setAppearanceLightStatusBars(!dark);
        controller.setAppearanceLightNavigationBars(!dark);
    }
}
