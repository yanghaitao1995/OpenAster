// SPDX-License-Identifier: Apache-2.0
package org.openaster.preview;

import android.content.res.Configuration;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(OpenAsterAppearance.class);
        super.onCreate(savedInstanceState);
        restoreAppearance();
    }

    @Override
    public void onResume() {
        super.onResume();
        restoreAppearance();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        restoreAppearance();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) restoreAppearance();
    }

    private void restoreAppearance() {
        AppearanceController.apply(this);
        // Core SystemBars posts its initialization. Apply again after that post;
        // apply() reads the latest mirror and ignores a destroyed activity.
        getWindow().getDecorView().post(() -> AppearanceController.apply(this));
    }
}
