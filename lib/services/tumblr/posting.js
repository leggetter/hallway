var fs        = require('fs');
var tumblrwks = require('tumblrwks');

function post(data, params, callback) {
  var blogName = data.to.profile;

  if (!blogName) {
    return callback(null, {
      error: 'Must target a blog. Use "to=blogname@tumblr,...".',
      see: 'https://singly.com/docs/sharing'
    });
  }
  // Tumblogs can't include a dot, so if it does, assume a custom domain
  if (blogName.indexOf('.') === -1) blogName = blogName + '.tumblr.com';

  var tumblr = new tumblrwks({
    consumerKey: data.auth.consumerKey,
    consumerSecret: data.auth.consumerSecret,
    accessToken: data.auth.token.oauth_token,
    accessSecret: data.auth.token.oauth_token_secret
  }, blogName);

  tumblr.post('/post', params, function(err, statusCode, body) {
    if (err) return callback(null, {error: err});
    return callback(null, body);
  });
}

function postStatus(data, callback) {
  post(data, {
    type: 'text',
    title: data.title,
    body: data.body
  }, callback);
}

function postLink(data, callback) {
  post(data, {
    type: 'link',
    url: data.url,
    title: data.title,
    description: data.body
  }, callback);
}

function postPhoto(data, callback) {
  fs.readFile(data.photo.path, function(err, photo) {
    if (err) return callback(null, {
      error: 'There was a problem uploading your photo.'}
    );

    post(data, {
      type: 'photo',
      data: photo
    }, callback);
  });
}

module.exports = {
  statuses : postStatus,
  links    : postLink, // Alias for backwards compatibility/friendliness
  news     : postLink,
  photos   : postPhoto
};
