var async = require('async');
var crypto = require('crypto');
var fs = require('fs');
var git = require('gift');
var request = require('request');
var _ = require('underscore')._;

// Get the hash of the current git revision
exports.currentRevision = function (cb) {
  var repo = git('.');

  repo.branch(function (err, head) {
    if (err || !head) {
      return cb(err);
    }

    cb(null, head);
  });
};

// Get the hash of the specified file
exports.hashFile = function (filename, cb) {
  var md5sum = crypto.createHash('md5');

  var s = fs.ReadStream(filename);

  s.on('data', function (data) {
    md5sum.update(data);
  });

  s.on('end', function () {
    cb(null, md5sum.digest('hex'));
  });

  s.on('error', function (e) {
    cb(e);
  });
};

// simple util for consistent but flexible binary options
exports.isTrue = function(field) {
  if (!field) return false;
  if (field === true) return true;
  if (field === "true") return true;
  if (field === "yes") return true;
  if (parseInt(field, 10) === 1) return true;

  return false;
};

// Found on http://bonsaiden.github.com/JavaScript-Garden/#types.typeof
exports.is = function(type, obj) {
  var clas = Object.prototype.toString.call(obj).slice(8, -1);
  return obj !== undefined && obj !== null && clas === type;
};

exports.addAll = function(thisArray, anotherArray) {
  if (!(thisArray && anotherArray && anotherArray.length))
    return;
  for(var i = 0; i < anotherArray.length; i++)
    thisArray.push(anotherArray[i]);
};

exports.ucfirst = function(str) {
  return str.charAt(0).toUpperCase() + str.substring(1).toLowerCase();
};

exports.getPropertyInObject = function(jsonObject, propertyName, callback) {
  var foundValues = [];

  function recurseObject(jsonObject, propertyName) {
    if (exports.is("Object", jsonObject)) {
      for (var m in jsonObject) {
        if (jsonObject.hasOwnProperty(m)) {
          if (m === propertyName) {
            foundValues.push(jsonObject[m]);
          }
          else if (exports.is("Object", jsonObject[m])) {
            recurseObject(jsonObject[m], propertyName);
          }
          else if (exports.is("Array", jsonObject[m])) {
            for (var n=0; n<jsonObject[m].length; n++) {
              recurseObject(jsonObject[m][n], propertyName);
            }
          }
        }
      }
    }
  }
  recurseObject(jsonObject, propertyName);
  callback(foundValues);
};

// quick/dirty sanitization ripped from the Jade template engine
exports.sanitize = function(term) {
  return String(term)
    .replace(/&(?!\w+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

exports.trim = function(str) {
  return str.replace(/^\s+|\s+$/g, '');
};

exports.atomicWriteFileSync = function(dest, data) {
  var tmp = dest + '.tmp';
  var bkp = dest + '.bkp';
  var stat;

  try {
    stat = fs.statSync(dest);
  } catch (err) {
  }

  // make a backup if the destination file already exists
  if (stat)
    fs.writeFileSync(bkp, fs.readFileSync(dest));

  // write out the new contents to a temp file
  fs.writeFileSync(tmp, data);

  // check if it worked
  if (data.length && fs.statSync(tmp).size !== Buffer.byteLength(data, 'utf8')) {
    throw new Error('atomic write error! file size !== data.length');
  }

  // atomically rename the temp file into place
  fs.renameSync(tmp, dest);
};

// processes a json newline stream, cbEach(json, callback) and cbDone(err) when done
exports.streamFromUrl = function(url, cbEach, cbDone) {
  var ended = false;
  var q = async.queue(function(chunk, cb) {
    if (chunk === "") return process.nextTick(cb);
    var js;
    // XXX: Can we use json: true in request.get to avoid this?
    try { js = JSON.parse(chunk); } catch (E) { return cb(); }
    cbEach(js, cb);
  },1);
  var error;
  var req = request.get({uri:url}, function(err) {
    if (err) error = err;
    ended = true;
    q.push(""); // this triggers the drain if there was no data, GOTCHA
  });
  var buff = "";
  req.on("data",function(data) {
    buff += data.toString();
    var chunks = buff.split('\n');
    buff = chunks.pop(); // if was end \n, == '', if mid-stream it'll be a not-yet-complete chunk of json
    chunks.forEach(q.push);
  });
  q.drain = function() {
    if (!ended) return; // drain can be called many times, we only care when it's after data is done coming in
    cbDone(error);
  };
  req.on("end",function() {
    ended = true;
    q.push(""); // this triggers the drain if there was no data, GOTCHA
  });
};

/// An async forEachSeries
/**
* The async implementation can explode the stack, this version will not.
*/
exports.forEachSeries = function(items, cbEach, cbDone) {
  function runOne(idx) {
    idx = idx || 0;
    if (idx >= items.length) return cbDone();
    cbEach(items[idx], function(err) {
      if (err) return cbDone(err);
      process.nextTick(function() {
        runOne(idx + 1);
      });
    });
  }
  runOne();
};

exports.jsonErr = function(msg, extras) {
  return _.extend(extras || {}, {error: exports.sanitize(msg)});
};

exports.selectFields = function(obj, fields) {
  // Accept 'a.b,c.d,e.f'
  if (typeof(fields) === 'string') {
    fields = fields.split(',');
  }
  // Accept ['a.b', 'c.d', 'e.f']
  if (typeof(fields[0]) === 'string') {
    fields.forEach(function(field, i) {
      fields[i] = field.split('.');
    });
  }

  if (fields.length === 0) return obj; // Done

  if (Array.isArray(obj)) {
    return _.map(obj, function(item) {
      return exports.selectFields(item, fields);
    });
  } else if(typeof(obj) === 'object'){
    var selected = {};
    fields.forEach(function(parts) {
      var name = parts[0];
      var rest = parts.slice(1);
      if (obj[name]) {
        var child = exports.selectFields(obj[name], (rest.length > 0) ? [rest] : []);
        if (typeof(selected[name]) === 'object') {
          selected[name] = _.extend(selected[name], child);
        } else {
          selected[name] = child;
        }
      }
    });
    return selected;
  } else { // Promitive (int, string, etc.)
    return obj;
  }
};

exports.trimObject = function(obj) {
  Object.keys(obj).forEach(function(key) {
    var val = obj[key];
    if (typeof(val) === 'string') {
      val = val.trim();
    } else if (typeof(val) === 'object') {
      val = exports.trimObject(val);
    }
    obj[key] = val;
  });
  return obj;
};
