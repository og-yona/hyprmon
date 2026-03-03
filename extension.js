/* extension.js */
// hyprmon is a Cinnamon extension that tries to mimic hyprland's window manager
// in its' "auto-tiling" features, allowing per-workspace enabling for hyprmon
// to take over for window management for auto-tiling windows in BSP, while 
// still allowing user to move and resize windows manually in a very flexible layout. 
// (Layout editor + Fancy Tiles snapping code removed; hyprmon is BSP tiling only.)

const { Application } = require('./application');

const UUID = 'hyprmon@og-yona';
let application = null;

//
// Cinnamon extensions lifecycle functions
// 

function init() {
}

function enable() {
    application = new Application(UUID);
}

function disable() {
    if (application) {
        application.destroy();
        application = null;
    }
}
/* extension.js END */