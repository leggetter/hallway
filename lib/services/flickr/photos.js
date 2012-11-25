/*
*
* Copyright (C) 2011, The Locker Project
* All rights reserved.
*
* Please see the LICENSE file for more information.
*
*/

var path = require('path');
var lib = require('./lib');

var PER_PAGE = 500;
exports.sync = function(pi, callback) {
  lib.getPage(pi, 'flickr.people.getPhotos', 'photo', PER_PAGE, {
    'user_id': 'me'
  }, function(err, config, photosArray) {
    if (err) return callback(err);
    var data = {};
    data['photo:' + pi.auth.pid + '/photos'] = photosArray;
    callback(null, {config: config, data: data});
  });
};
