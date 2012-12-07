var lconfig = require("lconfig");
var dal = require('dal');
var friends = require('friends');
var dMap = require('dMap');
var entries = require('entries');
var crypto = require('crypto');
var async = require('async');
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
  function cberr(err){
    logger.warn("authGet failed: %s %s %j", id, app, err);
    callback(err);
  };
  genGet(['auth'], id, function(err, obj){
    if (err) return cberr(err);
    if (!obj || !obj.auth) return cberr('missing auth info');
    // if no app-specific auth
    var auth = obj.auth;
    if (!app) return callback(null, auth);
    if (!auth.apps || !auth.apps[app]) return cberr('no auth for that app');
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

// shared function for /profile pattern
// options are { app:required, auth:truefalse, fresh:truefalse, full:truefalse }
exports.genProfile = function genProfile(profiles, options, cbDone)
{
  var bases = [];
  var pids = [];

  profiles.forEach(function (x) {
    var pid = (typeof x === 'object') ? x.profile : x;
    pids.push(pid);
    var type = dMap.defaults(pid.split('@')[1], 'self') || 'data';
    bases.push(type + ':' + pid + '/self');
  });

  if (bases.length === 0) return cbDone('No data or profile found');

  var ret = {
    id: options.account,
    services: {}
  };

  entries.runBases(bases, options, function (item) {
    friends.contactMerge(ret, item, options);
  }, function (err) {
    if (err) logger.error('error sending results for services', err);

    if (ret.email) {
      ret.gravatar = 'https://www.gravatar.com/avatar/' +
        crypto.createHash('md5').update(ret.email.toLowerCase()).digest('hex');
    }

    if (!options.auth) return cbDone(null, ret);
    getAuthsFromPIDs(pids, options, function (err, auths) {
      for (var service in auths) {
        if (!ret.services[service]) ret.services[service] = {};
        ret.services[service].auth = auths[service];
      }
      return cbDone(null, ret);
    });
  });

}

function getAuthsFromPIDs(pids, options, callback) {
  var auths = {};

  async.forEach(pids, function (pid, cbPID) {
    var service = pid.split('@')[1];
    exports.authGet(pid, options.app, function (err, auth) {
      auths[service] = {};
      if (err) {
        auths[service].error = err;
        return cbPID();
      }
      // add timestamps, might be useful!
      console.log(auth.accounts && auth.accounts[options.account])
      if (auth.accounts && auth.accounts[options.account]) auths[service].at = auth.accounts[options.account];
      // slightly heuristic
      if (auth.token) {
        if (typeof auth.token === 'string') {
          auths[service].token = auth.token;
          if (typeof auth.tokenSecret === 'string') {
            auths[service].token_secret = auth.tokenSecret;
          } else if (typeof auth.token_secret === 'string') {
            auths[service].token_secret = auth.token_secret;
          }
        } else if (auth.token.oauth_token && auth.token.oauth_token_secret) {
          auths[service] = {
            token: auth.token.oauth_token,
            token_secret: auth.token.oauth_token_secret
          };
        } else auths[service] = auth.token;
      }
      else if (auth.accessToken) auths[service].accessToken = auth.accessToken;

      // clear out instagram's user field
      if (auths[service].user) delete auths[service].user;
      cbPID();
    });
  }, function (err) {
    callback(err, auths);
  });
}
