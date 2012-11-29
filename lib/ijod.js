/*globals Buffer:true*/

/*
 *
 * Copyright (C) 2011, The Locker Project
 * All rights reserved.
 *
 * Please see the LICENSE file for more information.
 *
 */


/*
 * Indexed JSON On Disk
 */

var fs = require('fs');
var path = require('path');
var zlib = require('compress-buffer');
var lutil = require('lutil');
var async = require('async');
var lconfig = require('lconfig');
var idr = require('idr');
var logger = require('logger').logger('IJOD');
var dMap = require('dMap');
var mmh = require('murmurhash3');
var instruments = require('instruments');
var memcachelib = require('optional-memcache');
var memcache;
var qix = require('qix');
var entries = require('entries');
var friends = require('friends');
var partition = require('partition');

// Select the backend to use, based on the config. Default
// to use S3 for backwards comptability
var backend;
if (lconfig.ijod_backend === "file") {
  var fs_backend = require('ijod-fs');
  backend = new fs_backend.backend();
} else if (lconfig.ijod_backend === "s3") {
  var s3_backend = require('ijod-s3');
  backend = new s3_backend.backend();
} else if (lconfig.ijod_backend === "mem") {
  var mem_backend = require('ijod-mem');
  backend = new mem_backend.backend();
} else {
  logger.error("No ijod_backend specified. Please add a ijod_backend parameter to config.json " +
               "and specify one of 'file', 'mem' or 's3'.");
  process.exit(1);
}

exports.debug = lconfig.debug;

function qbox(options, binds) {
  var sql = '';
  if (options && options.box) {
    sql += ' AND lat > ? AND lat < ? AND lng > ? and lng < ?';
    binds.push(options.box.lat[0], options.box.lat[1], options.box.lng[0],
      options.box.lng[1]);
  }
  return sql;
}

function qq(q, sensitive) {
  if (!q) return '';
  var buf = qix.buf(q, sensitive);
  if (!buf) return '';
  var ret = '';
  for (var i = 0; i < 4; i++) {
    var hex = (i < 3) ? buf.slice(i * 8, (i * 8) + 8).toString('hex') :
      buf.slice(24).toString('hex');
    ret += " AND q" + i + " & x'" + hex + "' = x'" + hex + "'";
  }
  return ret;
}


// returns all rows but validates by idr (required in row)
function dbAll(base, sql, binds, cbDone)
{
  var ndx = {};
  var ret = [];
  instruments.increment("ijod.partitions."+(partition.getPart(base)||"none")+".range").send();
  instruments.increment("ijod.ranges").send();
  var pOld;
  var pNew;
  partition.readFrom(base, function(parts){
    if(exports.debug) logger.debug("dbAll", base, parts, sql, binds);
    async.forEach(parts, function(part, cbParts){
      if(part.priority == 0) pOld = part;
      if(part.priority == 1) pNew = part; // temp stuff! 
      // swap out name, and pass in clone of binds since it may get modd'd
      part.dal.query(sql.replace('T4BL3',part.table), binds.slice(0), function(err, rows){
        if(err) logger.warn("dbAll query failed",sql.replace('T4BL3',part.table), binds, err);
        if(rows) rows.forEach(function(row){
          if(ndx[row.idr]) { // if this idr exists, see if we have to replace it
            if(part.priority > ndx[row.idr].pri) {
              logger.debug("replacing old idr w/ newer copy",row.idr);
              ret.splice(ndx[row.idr].at, 1, row);
              ndx[row.idr].pri = part.priority; // is higher now, same offset
            }
            return;
          }
          // track it's offset for possible replacement
          ndx[row.idr] = {at:ret.length, pri:part.priority};
          ret.push(row);
        });
        cbParts();
      });
    }, function(){
      if(!pNew) return cbDone(null, ret);
      // temp hack to dedup ranges and ignore older ones
      var oldids = {};
      ret.forEach(function(row){
        if(ndx[row.idr].pri == pOld.priority) oldids[row.idr] = true;
      });
      var ins = Object.keys(oldids).map(function(id) { return "x'" + id + "'"; }).join(",");
      if(ins === "") return cbDone(null, ret);
      pNew.dal.query("select hex(idr) as idr from "+pNew.table+" where idr in ("+ins+")", [], function(err, rows){
        if(rows) rows.forEach(function(row){
          logger.debug("deleting old invalid instance",row.idr);
          ret.splice(ndx[row.idr].at, 1);
        });
        cbDone(null, ret);
      });
    });
  });
}

// we do the union and sort/limiting
function dbMany(base, sql, binds, sort, limit, cbDone)
{
  dbAll(base, sql, binds, function(err, rows){
    if(err) return cbDone(err);
    if(sort) rows.sort(sort);
    cbDone(null, limit ? rows.slice(0,limit) : rows);
  });
}

// just try to get one in order
function dbOne(id, sql, binds, cbDone)
{
  var ret = false;
  instruments.increment("ijod.partitions."+(partition.getPart(id)||"none")+".one").send();
  instruments.increment("ijod.ones").send();
  partition.readFrom(id, function(parts){
    // only do one at a time in order of priority until we find it
    parts.sort(function(a,b){ return b.priority - a.priority; });
    if(exports.debug) logger.debug("dbOne", id, parts, sql, binds);
    async.until(function(){ return ret !== false; }, function(cbUntil){
      if(parts.length === 0) {
        ret = [];
        return cbUntil();
      }
      part = parts.shift();
      part.dal.query(sql.replace('T4BL3',part.table), binds.slice(0), function(err, rows){
        if(err) logger.warn("dbOne query failed",sql.replace('T4BL3',part.table), binds, err);
        if(rows && rows.length > 0) ret = rows;
        cbUntil();
      });
    }, function(){
      cbDone(null, ret);
    });
  });
}

// returns all rows but validates by idr (required in row)
function dbMod(id, sql, binds, cbDone)
{
  instruments.increment("ijod.partitions."+(partition.getPart(id)||"none")+".mod").send();
  instruments.increment("ijod.mods").send();
  var source = (sql.substr(0,7).toLowerCase() === 'delete ') ? 'readFrom' : 'writeTo'; // delete mods need to hit all sources
  partition[source](id, function(parts){
    if(exports.debug) logger.debug("dbMod", id, parts, sql, binds);
    async.forEach(parts, function(part, cbParts){
      part.dal.query(sql.replace('T4BL3',part.table), binds.slice(0), function(err, rows){
        if(err) logger.warn("dbMod query failed",sql.replace('T4BL3',part.table), binds, err);
        cbParts();
      });
    }, cbDone);
  });
}

// get raw bits for friends filtering
exports.getPars = function(basePath, options, cbDone) {
  var now = Date.now();
  var path = options.xids ? ", path" : ""; // this is an annoying hack, need to get the referenced id from the row that is currently stored in the path
  var q = options.q ? ", (conv(hex(substr(base,17,6)),16,10) < "+now+" "+qq(options.q, true)+") as q" : ""; // do text search as a returned variable
  var bio = options.bio ? ", (conv(hex(substr(base,17,6)),16,10) > "+now+" "+qq(options.bio, false)+") as bio" : "";
  var sql = "SELECT conv(hex(substr(base,17,6)),16,10) as at, " +
    "lpad(hex(par),32,'0') as par, hex(idr) as idr, hash" + path + q + bio + " FROM T4BL3 WHERE " +
    "base > unhex(rpad(?,60,'0')) AND base < unhex(rpad(?,60,'f'))";
  var binds = [mmh.murmur128HexSync(basePath), mmh.murmur128HexSync(basePath)];
  if (options['in']) {
    var entryInClause = options['in'].map(function(id) {
      return "x'" + id + "'";
    }).join(",");
    sql += " AND idr in (" + entryInClause + ")";
  }
  dbAll(basePath, sql, binds, function(err, rows) {
    if (err) return cbDone(err);
    if (rows.length === 0) return cbDone(null);
    var ret = {};
    function ndxr(id, part) {
      // convenience
      if (part.substr(0,2) !== '00') ret[id].pars.push(part);
    }
    // pass again to index pars, two-pass is easier to detect the loner non-normals
    rows.forEach(function(row) {
      if (!row.par) return;
      var id = (row.at > now) ? row.hash.toUpperCase() : row.idr.toUpperCase(); // extra parallel rows
      if (!ret[id]) ret[id] = {pars:[]};
      if (options.xids && row.path) ret[id].xid = row.path;
      if (options.q && row.q > 0) ret[id].q = true;
      if (options.bio && row.bio > 0) ret[id].bio = true;
      ndxr(id, row.par.substr(0,8));
      ndxr(id, row.par.substr(8,8));
      ndxr(id, row.par.substr(16,8));
      ndxr(id, row.par.substr(24,8));
    });
    logger.debug("got idrs",Object.keys(ret).length);
    cbDone(null, ret);
  });
};

// just get the pars from one idr (all of them, or just one category of them)
exports.getOnePars = function(targetIdr, cat, cbDone) {
  if (typeof targetIdr !== 'string') return cbDone("invalid id: "+targetIdr);
  var hash = partition.getHash(targetIdr);
  var entryInClause;
  if (cat) { // just get one exact row
    entryInClause = "x'"+friends.parCat(hash, cat)+"'";
  }else{
    entryInClause = Object.keys(friends.parCats()).map(function(cat) {
      return "x'" + friends.parCat(hash, cat) + "'";
    }).join(",");
  }
  var sql = "SELECT lpad(hex(par),32,'0') as par, path, hex(idr) as idr FROM T4BL3 WHERE idr in ("+ entryInClause +")";
  dbAll(targetIdr, sql, [], function(err, rows) {
    if (err) return cbDone(err);
    if (rows.length === 0) return cbDone(null);
    var ret = {pars:[],path:rows[0].path};
    function ndxr(part) {
      if (part.substr(0,2) !== '00') ret.pars.push(part);
    }
    rows.forEach(function(row) {
      if (!row.par) return;
      // extra parallel rows
      ndxr(row.par.substr(0,8));
      ndxr(row.par.substr(8,8));
      ndxr(row.par.substr(16,8));
      ndxr(row.par.substr(24,8));
    });
    logger.debug("got pars", ret);
    cbDone(null, ret);
  });
};

// save a single row to entries table tying this id to this set of parallels
exports.setOneCat = function(id, cat, options, cbDone){
  // requires a raw idr
  if (!id || id.indexOf(':') === -1)
  {
    logger.warn("invalid id passed to setOnePars",id);
    return cbDone();
  }
  var parclean = [];
  if (options.pars) options.pars.forEach(function(par){
    if (parclean.indexOf(par) === -1) parclean.push(par);
  });
  parclean = parclean.slice(0,4);
  if (!options.ll) options.ll = [0,0];
  if (!options.q) options.q = ['','','',''];
  var sql = "INSERT INTO T4BL3 (base, idr, path, hash, par, lat, lng, q0, q1, q2, q3) VALUES (unhex(concat(rpad(?,32,'0'), lpad(hex(?),12,'0'), substr(?,1,16))), unhex(?), ?, ?, unhex(?), ?, ?, x?, x?, x?, x?) ON DUPLICATE KEY UPDATE base=VALUES(base), path=VALUES(path), hash=VALUES(hash), par=VALUES(par), lat=VALUES(lat), lng=VALUES(lng), q0=VALUES(q0), q1=VALUES(q1), q2=VALUES(q2), q3=VALUES(q3)";
  var at = Date.now()+(10*365*24*3600*1000); // 10yrs into the future, as a way to make sure they don't show up as a normal entry
  var binds = [
    idr.baseHash(id), at, idr.hash(id),
    friends.parCat(idr.hash(id), cat),
    idr.parse(id).hash.substr(0,128),
    idr.hash(id),
    parclean.join(''),
    options.ll[0], options.ll[1],
    options.q[0], options.q[1], options.q[2], options.q[3]
  ];
  logger.verbose("setOneCat",id,cat,options,sql,binds);
  dbMod(id, sql, binds, cbDone);
};

function qget(entry) {
  var oe = dMap.get('oembed', entry.data, entry.idr) || {};
  return [
    entry.q,
    (oe.type === 'link') ? oe.url: '',
    oe.title,
    oe.author_name,
    oe.handle,
    oe.email,
    dMap.get('text', entry.data, entry.idr)
  ].join(" "); // get all queryable strings
}

exports.qtext = qget;

function par2hex(part) {
  var ret = ((parseInt(mmh.murmur32HexSync(part),16) % 254)+1).toString(16);
  return (ret.length === 1) ? '0'+ret : ret;
}

// turn list of participants into proper sql filtering
function parq(parts) {
  if (!parts || parts.length === 0) return "";
  var ret = "";
  parts.forEach(function(part) {
    // syntax for requiring minimum number of unique participants
    if (part.indexOf(">") === 0) {
      var amt = parseInt(part.substr(1), 10);
      if (amt > 0) ret += " AND LENGTH(par) > "+amt;
      return;
    }
    var hex;
    // syntax for requiring this id as the author
    if (part.indexOf("^") === 0) {
      hex = (part === '^self') ? 'ff' : par2hex(part.substr(1));
      ret += " AND ORD(par) = ORD(x'"+hex+"')";
      return;
    }
    hex = (part === 'self') ? 'ff' : par2hex(part);
    ret += " AND INSTR(par, x'"+hex+"') > 0";
  });
  return ret;
}

// extract participant array with author at first
function parget(entry) {
  var ret = [];
  var author = idr.parse(entry.idr).auth;
  var dparts = dMap.get('participants', entry.data, entry.idr);
  if (dparts) Object.keys(dparts).forEach(function(id) {
    if (dparts[id].author) {
      author = id.toString();
      return;
    }
    ret.push(id.toString());
  });
  ret.unshift(author);
  return ret;
}

exports.participants = parget;

exports.initDB = function(callback) {
  memcache = memcachelib.memcacheClient();

  logger.info('Connecting to memcache...');

  memcache.connect(function() {
    logger.info("Connected to memcache");

    callback();
  });
};

var unicorn = 0; // ensure more uniqueness

function IJOD(basePath) {
  var self = this;
  this.transactionItems = null;
  this.transactionQueries = [];
  self.base = mmh.murmur128HexSync(basePath);
  self.path = path.join(self.base, "ijod." + Date.now()) + "." + unicorn++;
  self.len = 0;
}

exports.IJOD = IJOD;

IJOD.prototype.startAddTransaction = function() {
  if (this.transactionItems) return;
  this.transactionItems = [];
  this.transactionQueries = [];
  /*
  if (exports.debug) {
    logger.debug("****************************** BEGIN in normal " + this.base);
  }
  this.db.query("BEGIN", function(error, rows) { cbDone(); });
  */
};

IJOD.prototype.commitAddTransaction = function(cbDone) {
  if (!this.transactionItems || this.transactionItems.length === 0) {
    return cbDone();
  }
  //console.log("Committing %d items", this.transactionItems.length);
  var totalSize = this.transactionItems.reduce(function(prev, cur, idx, arr) {
    return prev + arr[idx].length;
  }, 0);
  instruments.modify({"ijod.write_total":totalSize}).send();
  var writeBuffer = new Buffer(totalSize);
  var idx = 0;
  var self = this;
  lutil.forEachSeries(self.transactionItems, function(item, cb) {
    item.copy(writeBuffer, idx);
    idx += item.length;
    cb();
  }, function(err) {
    var startTime = Date.now();
    backend.put(self.path, writeBuffer, function (err) {
      writeBuffer = null;
      if (!err) {
        logger.debug("Saving %d entries to ijod", self.transactionQueries.length);
        async.forEachLimit(self.transactionQueries, 5, function(query, cbQueries){
          dbMod(query.id, query.sql, query.binds, cbQueries);
        }, function(){
          instruments.timing({
            "ijod.save_time": (Date.now() - startTime)
          }).send();
          instruments.increment("ijod.puts").send();
          self.transactionItems = null;
          cbDone();          
        });
      } else {
        instruments.increment("ijod.put_errors").send();
        self.abortAddTransaction(cbDone);
      }
    });
  });
};

/// Abort a pending add transaction
/**
* Any pending write chunks are destroyed and the database transaction is rolled
* back. This is safe to call without a transaction started.
*/
IJOD.prototype.abortAddTransaction = function(cbDone) {
  if (!this.transactionItems) return cbDone();
  this.transactionItems = null;
  //this.db.query("ROLLBACK", function(error, rows) { cbDone(); });
};

// takes arg of at least an id and data, callback(err) when done
IJOD.prototype.addData = function(arg, callback) {
  if (!arg || !arg.idr) return callback("invalid arg");
  var tmpJson = JSON.stringify(arg);
  var hash = arg.hash ? arg.hash : mmh.murmur128HexSync(tmpJson);
  delete arg.hash;
  // ENTRY NORMALIZATION HAPPENS HERE
  if (!arg.at) arg.at = Date.now();
  arg.id = idr.id(arg.idr);
  arg.idr = idr.toString(arg.idr);
  var ll = dMap.get('ll',arg.data,arg.idr) || [null,null];
  // build our participant matching binary string
  var par = null;
  var participants = parget(arg);
  var parallels = friends.parallels(arg);
  // build our query matching, be more sensitive if there's parallels (friends) being indexed
  var q = qget(arg);
  var buf = qix.buf(q, (parallels.length > 0));
  var qx = [null,null,null,null];
  if (exports.debug) logger.debug("Q",arg.idr,q,buf&&buf.toString('hex'));
  var qsql = "?, ?, ?, ?";
  if (buf) {
    qsql = "x?, x?, x?, x?";
    qx[0] = buf.slice(0,8).toString('hex');
    qx[1] = buf.slice(8,16).toString('hex');
    qx[2] = buf.slice(16,24).toString('hex');
    qx[3] = buf.slice(24).toString('hex');
  }
  if (parallels.length > 0) {
    qsql += ', x?';
    par = parallels.join('');
  } else if (participants.length > 0) {
    qsql += ', x?';
    var owner = idr.parse(arg.idr).auth;
    par = '';
    // each one is the raw id string
    participants.forEach(function(part) {
      // owner is special to optimize for worst case overlaps, everyone else is
      // 1-254, 0 is reserved
      par += (part === owner) ? 'ff' : par2hex(part);
    });
  } else {
    qsql += ', ?';
  }
  var self = this;
  this.startAddTransaction();
  tmpJson = JSON.stringify(arg);
  var gzdata = zlib.compress(new Buffer(tmpJson+"\n"));
  self.transactionItems.push(gzdata);
  var offset = self.len;
  self.len += gzdata.length;
  arg.saved = Date.now(); // for pumps in the pipeline after ijod to know if it was saved

  memcache.replace(idr.hash(arg.idr), tmpJson, function(error, result) {
    // TODO, also replace idr2 in types?
  });

  var sql = "INSERT INTO T4BL3 (base, idr, path, hash, offset, len, lat, " +
    "lng, q0, q1, q2, q3, par) VALUES (unhex(concat(rpad(?,32,'0'), " +
    "lpad(hex(?),12,'0'), substr(?,1,16))), unhex(?), ?, ?, ?, ?, ?, ?, " +
    qsql + ") ON DUPLICATE KEY UPDATE base=VALUES(base), " +
    "path=VALUES(path), hash=VALUES(hash), offset=VALUES(offset), " +
    "len=VALUES(len), lat=VALUES(lat), lng=VALUES(lng), q0=VALUES(q0), " +
    "q1=VALUES(q1), q2=VALUES(q2), q3=VALUES(q3), par=VALUES(par)";

  self.transactionQueries.push({id:idr.toString(arg.idr), sql:sql, binds:[
    idr.baseHash(arg.idr),
    arg.at,
    idr.hash(arg.idr),
    idr.hash(arg.idr),
    self.path,
    hash,
    offset,
    (self.len - offset),
    ll[0], ll[1],
    qx[0], qx[1], qx[2], qx[3],
    par
  ]});

  // if there's types, insert each of them too for filtering
  if (!arg.data || !arg.types) return callback();

  // TODO: This doesn't call any async code and can be converted
  async.forEachSeries(Object.keys(arg.types), function(type, cb) {
    var i2 = idr.clone(arg.idr);
    i2.protocol = type;
    instruments.increment("data.types." + type).send();

    if (typeof arg.types[type] === 'object' && arg.types[type].auth) {
      // also index this with a different auth!
      i2.auth = arg.types[type].auth;
    }

    self.transactionQueries.push({id:idr.toString(arg.idr), sql:sql, binds:[
      idr.baseHash(i2),
      arg.at,
      idr.hash(i2),
      idr.hash(i2),
      self.path,
      hash,
      offset,
      (self.len - offset),
      ll[0], ll[1],
      qx[0], qx[1], qx[2], qx[3],
      par
    ]});

    cb();
  }, callback);
};

/// Get a single entry from an IJOD, requested by specific IDR
exports.getOne = function(targetIdr, callback) {
  var startTime = Date.now();
  // take the raw id if given too
  if (typeof targetIdr !== 'string') return callback("invalid id: "+targetIdr);
  var hash = partition.getHash(targetIdr);
  memcache.get(hash, function(error, result) {
    var js;
    try {
      js = JSON.parse(result[hash]);
    } catch(E) {}
    if (error || result === "NOT_STORED" || result === null || !js) {
      var sql = "SELECT path, offset, len FROM T4BL3 WHERE idr = x? LIMIT 1";
      var binds = [hash];
      dbOne(targetIdr, sql, binds, function(error, rows) {
        if (error) return callback(error);
        if (rows.length !== 1 || !rows[0].len || rows[0].len === 0) {
          return callback(new Error("Bad query for getOne"));
        }
        var buf = new Buffer(rows[0].len);
        if (exports.debug) {
          logger.debug("%s - Range: bytes=" + rows[0].offset +
            "-" + (rows[0].offset + rows[0].len - 1), rows[0].path);
        }

        backend.get(rows[0].path, rows[0].offset, buf.length, function (err, buf) {
          if (err) return callback(err);

          var zbuf = zlib.uncompress(buf);
          if (!zbuf) {
            logger.error("Invalid data from backend for %s", rows[0].path);
            return callback(new Error("Invalid ijod entry requested"));
          }

          var jsonStr = zbuf.toString();
          var data = JSON.parse(jsonStr);
          if (exports.debug) {
            logger.debug("Get one in %d", (Date.now() - startTime));
          }

          memcache.set(hash, jsonStr, function(error, result) {
            if (error) logger.error(error);
            callback(null, data);
          });
        }); // backend.get
      }); // dal.query
    } else {
      if (exports.debug) {
        logger.debug("Get one in %d", (Date.now() - startTime));
      }
      callback(null, js);
    }
  });
};

// simple single deleter, initially used to remove tasks
exports.delOne = function(targetIdr, callback) {
  // take the raw id if given too
  if (typeof targetIdr !== 'string') return callback("invalid id: "+targetIdr);
  var hash = partition.getHash(targetIdr);
  logger.debug("deleting",targetIdr,hash);
  memcache.del(hash, function(error, result) {
    dbMod(targetIdr, "DELETE FROM T4BL3 WHERE idr = x? LIMIT 1", [hash], callback);
  });
};

/// Select a time based range of IJOD entries.
/**
* range is optional and will default to all entries, when supplied it should
* have start and end values.  The range is inclusive.
*
* Results are returned in reverse chronological order.
*/
exports.getRange = function(basePath, range, cbEach, cbDone) {
  var startRangeTime = Date.now();
  var sql = "SELECT path, offset, len, hex(idr) as idr, conv(hex(substr(base,17,6)),16,10) as at FROM T4BL3 WHERE base > " +
    "unhex(concat(rpad(?,32,'0'), lpad(hex(?),12,'0'),'0000000000000000')) " +
    "AND base < unhex(concat(rpad(?,32,'0'),lpad(hex(?),12,'0'), " +
    "'ffffffffffffffff'))";
  var binds = [
    mmh.murmur128HexSync(basePath),
    range.since || 0,
    mmh.murmur128HexSync(basePath),
    range.until || Date.now()
  ];
  sql += qbox(range, binds);
  sql += qq(range.q);
  sql += parq(range.participants);
  sql += " ORDER BY at " + (range.reverse ? "ASC" : "DESC");
  var limit;
  if (range.limit) {
    limit = parseInt(range.limit, 10);
    // these are internally lossy, so try to compensate to prevent a second pass
    // from entries.js
    if (range.q) limit += limit * 0.1;
    if (range.participants) limit += limit * 0.1;
    limit = parseInt(limit, 10);
    sql += " LIMIT " + limit;
  }
  if (range.offset) {
    sql += " OFFSET " + parseInt(range.offset, 10);
  }
  dbMany(basePath, sql, binds, function(a, b){ return (range.reverse ? a - b : b - a); }, limit, function(error, rows) {
    if (error) return cbDone(error);
    var flags = {rawlen:rows.length};
    if (rows.length === 0) return cbDone(null, flags);

    // Process the curPath
    function processPath(pathData, cbPath) {
      if (pathData.ranges.length === 0) {
        process.nextTick(cbPath);
      }

      if (exports.debug) logger.debug(JSON.stringify(pathData.ranges));

      // Find the extents and create a range string
      var start = pathData.ranges[0].start;
      var end = pathData.ranges[0].end;

      pathData.ranges.forEach(function(range) {
        if (range.start < start) start = range.start;
        if (range.end > end) end = range.end;
      });
      // Shift the offsets if we're not 0 based anymore
      if (start > 0) {
        pathData.ranges.forEach(function(range) {
          range.start -= start;
          range.end -= start;
        });
      }

      backend.get(pathData.path, start, end - start, function(err, buf) {
        if (err) return cbPath(null, []);
        var pieces = [];
        for (var i = 0; i < pathData.ranges.length; ++i) {
          var range = pathData.ranges[i];
          var curBuf = buf.slice(range.start, range.end);
          var decompressed = zlib.uncompress(curBuf);
          if (decompressed) {
            pieces.push(JSON.parse(decompressed.toString()));
          } else {
            logger.error("Error decompressing %s range: %d - %d",
                         pathData.path, range.start, range.end);
            logger.error("Cur pieces: %j", pieces);
            return cbPath(null, []);
          }
        }
        cbPath(null, pieces);
      }); // backend.get
    }

    function addRowToRanges(row, ranges) {
      ranges.push({len:row.len, start:row.offset, end:(row.offset + row.len)});
    }

    var paths = [];
    // Break this down into individual paths
    rows.forEach(function(row) {

      if (paths.length === 0 || row.path !== paths[paths.length - 1].path) {
        paths.push({ranges:[], path:row.path});
      }
      addRowToRanges(row, paths[paths.length - 1].ranges);
    });

    async.map(paths, processPath, function(error, results) {
      for (var i = 0; i < results.length; ++i) {
        if (!results[i]) continue;
        entries.filter(results[i], range).forEach(cbEach);
      }
      if (exports.debug) {
        logger.debug("Range run time: %d", (Date.now() - startRangeTime));
      }
      return cbDone(error, flags);
    });
  });
};

exports.batchSmartAdd = function(entries, callback) {
  if (entries.length === 0) return process.nextTick(callback);
  var pidPath = idr.pid(entries[0].idr);
  var basePath = idr.toString(idr.base(entries[0].idr));
  var ij = new IJOD(pidPath);
  logger.debug("Batch smart add", pidPath, entries.length);

  var timings = {};
  function handleError(msg) {
    logger.error("Batch smart add error: %s", msg);
    if (exports.debug) {
      logger.trace();
    }
    callback(msg, timings);
  }

  var entryInClause = entries.map(function(entry) {
    return "x'" + idr.hash(entry.idr) + "'";
  }).join(",");
  var sql = "SELECT hex(idr) as idr, hash FROM T4BL3 WHERE idr IN (" + entryInClause + ")";
  var start = Date.now();
  dbAll(basePath, sql, [], function(error, rows) {
    timings.dalQuery = Date.now() - start;
    if (error) return handleError(error);
    var knownIds = {};
    rows = rows || [];
    rows.forEach(function(row) {
      knownIds[row.idr.toLowerCase()] = row.hash;
    });
    ij.startAddTransaction();
    start = Date.now();
    async.forEachSeries(entries, function(entry, cb) {
      if (!entry) {
        return process.nextTick(cb);
      }
      var entryIdrHash = idr.hash(entry.idr);
      if (knownIds[entryIdrHash]) {
        // See if we need to update
        var hash = mmh.murmur128HexSync(JSON.stringify(entry));
        // If the id and hashes match it's the same!
        if (hash === knownIds[entryIdrHash]) {
          instruments.increment("ijod.skipped_on_hash").send();
          return process.nextTick(cb);
        } else {
          entry.hash = hash;
        }
      }
      // XXX This might be able to convert to a regular forEach?
      ij.addData(entry, function() { process.nextTick(cb); });
    }, function(error) {
      timings.addData = Date.now() - start;
      if (error) {
        ij.abortAddTransaction(function() {
          handleError(error);
        });

        // This is OK because handleError calls callback()
        return;
      }

      start = Date.now();
      ij.commitAddTransaction(function(error) {
        timings.commit = Date.now() - start;
        callback(error, timings);
      });

      //console.log("Batch done: %d", (Date.now() - t));
    }); // forEachSeries(entries)
  });
};

// just quickly return the at bounds of a potential range request
exports.getBounds = function(basePath, range, cbDone) {
  // gotta use a subquery to get the actual limit applied!
  var since = (range && range.since) ? range.since : 0;
  var until = (range && range.until) ? range.until : Date.now();
  // dbAll dedup's rows based on idr, so work around that
  var sql = "SELECT MAX(at) as newest, MIN(at) as oldest, COUNT(*) as total, HEX(RAND()*1000000000) as idr " +
    "FROM (SELECT conv(hex(substr(base,17,6)),16,10) as at FROM T4BL3 " +
    "WHERE base > unhex(concat(rpad(?,32,'0'), lpad(hex(?),12,'0'), " +
    "'0000000000000000')) AND base < unhex(concat(rpad(?,32,'0'), " +
    "lpad(hex(?),12,'0'),'ffffffffffffffff'))";
  var binds = [mmh.murmur128HexSync(basePath), since,
    mmh.murmur128HexSync(basePath), until];
  sql += qbox(range, binds);
  sql += qq(range.q);
  sql += parq(range.participants);
  sql += ") AS sq1";
  dbAll(basePath, sql, binds, function(error, rows) {
    if (exports.debug) logger.debug("bounds", basePath, range, rows);
    if (error) return cbDone(error);
    if (rows.length === 0) return cbDone(null);
    var ret = {newest:0, oldest:0, total:0};
    rows.forEach(function(row){
      if(row.newest > ret.newest) ret.newest = row.newest;
      if(ret.oldest === 0 || row.oldest < ret.oldest) ret.oldest = row.oldest;
      ret.total += parseInt(row.total, 10);
    });
    cbDone(null, ret);
  });
};

// only the timestamps for manual merging/windowing in entries.js
exports.getTardis = function(basePath, range, cbDone) {
  var since = (range && range.since) ? range.since : 0;
  var until = (range && range.until) ? range.until : Date.now();
  var sql = "SELECT conv(hex(substr(base,17,6)),16,10) as at, hex(idr) as idr FROM T4BL3 " +
    "WHERE base > unhex(concat(rpad(?,32,'0'), lpad(hex(?), 12, '0'), " +
    "'0000000000000000')) AND base < unhex(concat(rpad(?,32,'0'), " +
    "lpad(hex(?),12,'0'),'ffffffffffffffff'))";
  var binds = [mmh.murmur128HexSync(basePath), since,
    mmh.murmur128HexSync(basePath), until];
  sql += qbox(range, binds);
  sql += qq(range.q);
  sql += parq(range.participants);
  dbAll(basePath, sql, binds, cbDone);
};

// remove the hash so that any changes are re-saved, for internal use when data is indexed and not in ijod
exports.spoil = function(basePath, cbDone) {
  var sql = "UPDATE T4BL3 SET hash='' " +
    "WHERE base > unhex(concat(rpad(?,32,'0'), lpad(hex(?), 12, '0'), " +
    "'0000000000000000')) AND base < unhex(concat(rpad(?,32,'0'), " +
    "lpad(hex(?),12,'0'),'ffffffffffffffff'))";
  var binds = [mmh.murmur128HexSync(basePath), 0, mmh.murmur128HexSync(basePath), Date.now()];
  logger.warn("SPOILING ",basePath, sql,"Binds: ",JSON.stringify(binds));
  dbMod(basePath, sql, binds, cbDone);
};

// Takes a complete changeset breaks it down by base and saves it to S3
exports.pump = function(arg, cbDone) {
  if (!arg || !Array.isArray(arg)) {
    return cbDone(new Error("arg is missing or invalid: " +
      JSON.stringify(arg)));
  }

  // XXX: Is this actually an error?
  if (arg.length === 0) return cbDone();

  // create a batch for each base
  var bases = {};
  arg.forEach(function(entry) {
    var base = idr.pid(entry.idr);
    if (!bases[base]) bases[base] = [];
    bases[base].push(entry);
  });

  // do each clustering
  logger.debug("Pumping", Object.keys(bases).join(" "));

  var timings = {};
  var start = Date.now();
  async.forEach(Object.keys(bases), function(base, cb) {
    exports.batchSmartAdd(bases[base], function(error, timing) {
      if (error) return cb(error);
      if (timing) timings[base] = timing;
      cb();
    });
  }, function(error) {
    logger.debug("Pump done", Object.keys(bases), 'err:', error);
    var et = Date.now() - start;
    var avg = et / arg.length;
    // only log for slow queries
    if (avg > lconfig.ijod.slowPump.avg && et > lconfig.ijod.slowPump.et) {
      logger.warn('IJOD pump took > %d ms (%d ms) for each of %d entries, %j',
        lconfig.ijod.slowPump.avg, Math.round(avg), arg.length, timings);
    }
    cbDone(error ? error : null, error ? null : arg);
  });
};
