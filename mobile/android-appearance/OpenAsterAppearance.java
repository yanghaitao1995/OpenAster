// SPDX-License-Identifier: Apache-2.0
package org.openaster.preview;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "OpenAsterAppearance")
public final class OpenAsterAppearance extends Plugin {
    @PluginMethod
    public void setTheme(PluginCall call) {
        final String theme;
        try {
            if (call.getData().length() != 1) throw new IllegalArgumentException();
            theme = AppearanceTheme.requireTheme(call.getData().opt("theme"));
        } catch (IllegalArgumentException error) {
            call.reject("Invalid appearance theme", "INVALID_APPEARANCE_THEME");
            return;
        }
        try {
            if (!(getActivity() instanceof MainActivity) || !AppearanceController.store(getContext(), theme)) {
                call.reject("Appearance could not be applied", "APPEARANCE_UNAVAILABLE");
                return;
            }
            getBridge().executeOnMainThread(() -> {
                try {
                    MainActivity activity = (MainActivity) getActivity();
                    if (activity.isFinishing() || activity.isDestroyed()) {
                        call.reject("Appearance could not be applied", "APPEARANCE_UNAVAILABLE");
                        return;
                    }
                    AppearanceController.apply(activity);
                    call.resolve();
                } catch (RuntimeException error) {
                    call.reject("Appearance could not be applied", "APPEARANCE_UNAVAILABLE");
                }
            });
        } catch (RuntimeException error) {
            call.reject("Appearance could not be applied", "APPEARANCE_UNAVAILABLE");
        }
    }
}
