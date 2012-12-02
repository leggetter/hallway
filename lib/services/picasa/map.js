function tee(val)
{
  return val && val.$t;
}

exports.profile = {
  id: function(data) { return tee(data.gphoto$user); },
  oembed: function(data) {
    var ret = {
      id: tee(data.gphoto$user),
      title: tee(data.gphoto$nickname),
      url: data.author && data.author[0] && tee(data.author[0].uri),
      thumbnail_url: tee(data.gphoto$thumbnail),
      provider_name: 'picasa'
    };
    return ret;
  }
}

exports.defaults = {
  self: 'profile'
}

