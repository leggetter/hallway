var fs      = require('fs');
var mime    = require('mime');
var path    = require('path');
var request = require('request');
var twitter = require(path.join(__dirname, 'twitter_client.js'));
var _ = require('underscore')._;

var TWITTER_API_BASE = 'https://api.twitter.com/1.1';

function post(endpoint, data, params, callback) {
  params.oauth = {
    consumer_key: data.auth.consumerKey,
    consumer_secret: data.auth.consumerSecret,
    token: data.auth.token.oauth_token,
    token_secret: data.auth.token.oauth_token_secret
  };
  var url = TWITTER_API_BASE + endpoint + '.json';
  request.post(url, params, function(err, resp, body) {
    if (err) {
      try {
        err = JSON.parse(err.data).error;
      } catch(E) {
        err = "Unknown error in: " + (err && err.data);
      }
      return callback(null, {error: err});
    }
    try {
      body = JSON.parse(body);
    } catch(E) {
      // Pass
    }
    return callback(null, body);
  });
}

function postStatus(data, callback) {
  post('/statuses/update', data, {
    headers: { 'content-type': 'multipart/form-data' },
    multipart: [
      {
        'Content-Disposition': 'form-data; name="status"',
        body: data.body || ''
      }
    ]
  }, callback);
}

function postLink(data, callback) {
  if (!data.body.match(data.url)) {
    data = _.clone(data);
    data.body = data.body + ' ' + data.url;
  }
  postStatus(data, callback);
}

function postPhoto(data, callback) {
  fs.readFile(data.photo.path, function(err, photo) {
    if (err) return callback(null, {
      error: 'There was a problem uploading your photo.'}
    );

    post('/statuses/update_with_media', data, {
      headers: { 'content-type': 'multipart/form-data' },
      multipart: [
        {
          'Content-Disposition': 'form-data; name="status"',
          body: data.body || ''
        },
        {
          'Content-Disposition':
            'form-data; name="media[]"; filename="' + data.photo.name + '"',
          'Content-Type':
            mime.lookup(data.photo.name),
          body: photo
        }
      ]
    }, callback);
  });
}

module.exports = {
  statuses : postStatus,
  links    : postLink, // Alias for backwards compatibility/friendliness
  news     : postLink,
  photos   : postPhoto
};
