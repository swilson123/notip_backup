// LCD 1 (0x27): GPS position
// LCD 2 (0x26): Navigation — heading, speed, waypoint
// LCD 3 (0x25): Mission status — mode, path, obstacle

function pad(str, len) {
    return String(str).slice(0, len).padEnd(len);
}

var write_to_lcd = async function (rover) {

    if (rover.lcd_screens.screen1.connected) {
        const lcd = rover.lcd_screens.screen1.instance;
        const gps = rover.robot_data.GLOBAL_POSITION_INT;
        const lat = gps.lat ? (gps.lat / 1e7).toFixed(5) : '---';
        const lon = gps.lon ? (gps.lon / 1e7).toFixed(5) : '---';
        await lcd.clear();
        await lcd.setCursor(0, 0);
        await lcd.writeString(pad(`LAT:${lat}`, 16));
        await lcd.setCursor(0, 1);
        await lcd.writeString(pad(`LON:${lon}`, 16));
    }

    if (rover.lcd_screens.screen2.connected) {
        const lcd = rover.lcd_screens.screen2.instance;
        const hud = rover.robot_data.VFR_HUD;
        const heading = hud.heading != null ? Math.round(hud.heading) : '---';
        const speed   = hud.groundspeed != null ? hud.groundspeed.toFixed(1) : '-.-';
        const step    = rover.mission.current_mission_seq;
        const total   = rover.mission.mission_count;
        await lcd.clear();
        await lcd.setCursor(0, 0);
        await lcd.writeString(pad(`HDG:${heading}  SPD:${speed}`, 16));
        await lcd.setCursor(0, 1);
        await lcd.writeString(pad(`WPT:${step}/${total}`, 16));
    }

    if (rover.lcd_screens.screen3.connected) {
        const lcd = rover.lcd_screens.screen3.instance;
        const mode      = rover.flight_data.robot_flight_mode || '---';
        const pathClear = rover.mission.path_clear ? 'CLEAR' : 'BLOCK';
        const delivered = rover.mission.package_delivered ? 'DELVD' : 'READY';
        await lcd.clear();
        await lcd.setCursor(0, 0);
        await lcd.writeString(pad(`MD:${mode}`, 16));
        await lcd.setCursor(0, 1);
        await lcd.writeString(pad(`${pathClear} ${delivered}`, 16));
    }

};

module.exports = write_to_lcd;
