// Waveshare DDSM JSON command constants and small helper API
// Auto-generated from ddsm_example/json_cmd.h

const COMMANDS = {
  FB_MOTOR: { T: 20010, desc: 'Feedback: motor data (FB_MOTOR)' },
  FB_INFO: { T: 20011, desc: 'Feedback: info data (FB_INFO)' },

  CMD_DDSM_STOP: { T: 10000, desc: 'Stop motor', example: (id) => ({ T: 10000, id }) },
  CMD_DDSM_CTRL: { T: 10010, desc: 'Control motor (current/speed/position)', example: (id, cmd, act) => ({ T: 10010, id, cmd, act }) },
  CMD_DDSM_CHANGE_ID: { T: 10011, desc: 'Change motor ID', example: (id) => ({ T: 10011, id }) },
  CMD_CHANGE_MODE: { T: 10012, desc: 'Change motor mode', example: (id, mode) => ({ T: 10012, id, mode }) },

  CMD_DDSM_ID_CHECK: { T: 10031, desc: 'Query motor ID (only one motor connected)', example: () => ({ T: 10031 }) },
  CMD_DDSM_INFO: { T: 10032, desc: 'Request motor info', example: (id) => ({ T: 10032, id }) },

  CMD_HEARTBEAT_TIME: { T: 11001, desc: 'Set heartbeat timeout (ms). -1 disables auto-stop', example: (timeMs) => ({ T: 11001, time: timeMs }) },
  CMD_TYPE: { T: 11002, desc: 'Set DDSM type (115 or 210)', example: (type) => ({ T: 11002, type }) },

  CMD_WIFI_ON_BOOT: { T: 10401, desc: 'Set wifi-on-boot mode', example: (cmd) => ({ T: 10401, cmd }) },
  CMD_SET_AP: { T: 10402, desc: 'Configure AP mode', example: (ssid, password) => ({ T: 10402, ssid, password }) },
  CMD_SET_STA: { T: 10403, desc: 'Configure STA mode', example: (ssid, password) => ({ T: 10403, ssid, password }) },
  CMD_WIFI_APSTA: { T: 10404, desc: 'Configure AP+STA', example: (ap_ssid, ap_password, sta_ssid, sta_password) => ({ T: 10404, ap_ssid, ap_password, sta_ssid, sta_password }) },
  CMD_WIFI_INFO: { T: 10405, desc: 'Query wifi info', example: () => ({ T: 10405 }) },
  CMD_WIFI_CONFIG_CREATE_BY_STATUS: { T: 10406, desc: 'Create wifiConfig.json from status', example: () => ({ T: 10406 }) },
  CMD_WIFI_CONFIG_CREATE_BY_INPUT: { T: 10407, desc: 'Create wifiConfig.json by input', example: (obj) => Object.assign({ T: 10407 }, obj) },
  CMD_WIFI_STOP: { T: 10408, desc: 'Disconnect wifi', example: () => ({ T: 10408 }) },

  CMD_REBOOT: { T: 600, desc: 'Reboot ESP32', example: () => ({ T: 600 }) },
  CMD_FREE_FLASH_SPACE: { T: 601, desc: 'Query free flash space', example: () => ({ T: 601 }) },
  CMD_RESET_WIFI_SETTINGS: { T: 603, desc: 'Reset wifi settings', example: () => ({ T: 603 }) },
  CMD_NVS_CLEAR: { T: 604, desc: 'Clear NVS', example: () => ({ T: 604 }) }
};

// Small helper: build a message by command name or T value
function buildCommandByName(name, ...args) {
  const key = String(name);
  const info = COMMANDS[key];
  if (!info) throw new Error('Unknown command name: ' + name);
  if (typeof info.example === 'function') return info.example(...args);
  return { T: info.T };
}

function buildCommandByT(T, payload = {}) {
  return Object.assign({ T }, payload);
}

module.exports = {
  COMMANDS,
  buildCommandByName,
  buildCommandByT
};
