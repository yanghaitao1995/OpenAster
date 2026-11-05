// SPDX-License-Identifier: Apache-2.0
package org.openaster.preview;

/** The bridge accepts a theme name, never an arbitrary color or settings map. */
final class AppearanceTheme {
    private AppearanceTheme() {}

    static String requireTheme(Object value) {
        if (!"light".equals(value) && !"dark".equals(value)) {
            throw new IllegalArgumentException("Invalid appearance theme");
        }
        return (String) value;
    }

    static String savedTheme(Object value) {
        return "dark".equals(value) ? "dark" : "light";
    }

    static int background(String theme) {
        return "dark".equals(requireTheme(theme)) ? 0xff1c1c1e : 0xffffffff;
    }
}
