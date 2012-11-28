var lconfig = require("lconfig");
var dal = require('dal');
var logger = require('logger').logger("profileManager");


exports.init = function(callback) {
  logger.debug("Profile Manager Table Creation");
  callback();
};

// generically get a JSON object for a profile, and make sure the row exists
function genGet(fields, id, callback) {
  var sql = "SELECT "+fields.join(",")+" FROM Profiles WHERE id = ? LIMIT 1";
  var select = dal.query(sql, [id], function(err, rows) {
    if (err) logger.warn(err, select);
    var ret = {};
    // parse each field returned into an object
    if (rows && rows.length === 1) {
      for(var i = 0; i < fields.length; i++) {
        var key = fields[i];
        var body = rows[0][key];
        try {
          ret[key] = JSON.parse(body);
        } catch(E) {
          ret[key] = {}; // ensure a blank exists at least
          logger.warn("for %s, failed to process Profile.%s: %j",
                           id, key, E);
        }
      }
    }
    if (rows && rows.length === 1) return callback(err, ret);

    // catch if there's no entry yet and make sure there is one so that
    // UPDATE syntax works!
    var parts = id.split('@');
    var insert = dal.query(
      "INSERT INTO Profiles (id, service) VALUES (?, ?)",
      [id, parts[1]],
      function(err2) {
        if (err2) logger.error("query failed: ", insert, err2);
        callback(err, ret); // return original now
      }
    );
  });
}

// generically merge update a JSON object for a profile
function genSet(field, id, val, callback) {
  genGet([field], id, function(err, old) {
    if (err) return callback(err);
    if (typeof val === 'object') {
      if (!old[field]) old[field] = {};
      // WARNING, this is a dumb merge! just flat replace keys
      Object.keys(val).forEach(function(key){
        old[field][key] = val[key];
      });
      val = JSON.stringify(old[field]);
    }
    var q = dal.query(
      "UPDATE Profiles SET `" + field + "` = ? WHERE id = ?",
      [val, id],
      function(err){
        if (err) logger.error("query failed: ",q, err);
        callback(err);
      }
    );
  });
}

// TODO switch to entries

// get/set the stored auth/config info if any
exports.authGet = function(id, app, callback) {
  genGet(['auth'], id, function(err, obj){
    if (err || !obj || !obj.auth) return callback(err);
    // if no app-specific auth
    var auth = obj.auth;
    if (!app) return callback(null, auth);
    if (!auth.apps || !auth.apps[app]) return callback('no auth for that app');
    // merge up the app stuff and return it!
    Object.keys(auth.apps[app]).forEach(function(key){
      auth[key] = auth.apps[app][key];
    });
    callback(null, auth);
  });
};

// do magic to store auth per app when given
exports.authSet = function(id, js, app, callback) {
  genGet(['auth'], id, function(err, old) {
    if (err) return callback(err, js);

    var newAuth = js;
    if (old && old.auth && Object.keys(old.auth).length) {
      // merge new into old
      newAuth = old.auth;
      Object.keys(js).forEach(function(key) {
        // don't merge the apps key, we'll do that later
        if (key === "apps") return;
        newAuth[key] = js[key];
      });
    }

    if (app) {
      // gross, but need to keep track of all the access tokens, etc per app
      // so we store them each in their own key. This updates just the current
      // one we are working with.
      var copy = JSON.parse(JSON.stringify(js));
      delete copy.profile;
      delete copy.pid;
      delete copy.apps;
      copy.at = Date.now();
      if (!newAuth.apps) newAuth.apps = {};

      // this just puts the app-specific stuff (tokens, api keys, account #s)
      // into the auth.apps[app] field for safe keeping
      newAuth.apps[app] = copy;
    }
    var q = dal.query(
      "UPDATE Profiles SET `auth` = ? WHERE id = ?",
      [JSON.stringify(newAuth), id],
      function(err) {
      if (err) logger.error("query failed: ", q, err);
      callback(err, newAuth);
    });
  });
};

exports.configGet = function(id, callback) {
  genGet(['config'], id, function(err, obj){
    callback(err, obj && obj.config);
  });
};
exports.configSet = function(id, js, callback) {
  genSet('config', id, js, callback);
};
exports.allGet = function(id, callback) {
  genGet(['config', 'auth'], id, callback);
};

exports.reset = function(id, callback) {
  dal.query("UPDATE Profiles set config='{}' WHERE id=?", [id], callback);
};

