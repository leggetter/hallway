exports.ptype = 106; // must be unique per service, see dMap.js

exports.profile = {
  id: 'kloutId'
}

exports.entity = {
  oembed: function(data) {
    var ret = {type:'contact'};
    ret.provider_name = 'klout';
    ret.title = data.payload.nick;
    ret.handle = data.payload.nick;
    ret.url = 'http://klout.com/user/'+data.payload.nick;
    return ret;
  },
  text: function(data) { return data.payload && data.payload.nick }
}

exports.defaults = {
  self: 'profile',
  influencers: 'entity',
  influencees: 'entity',
  topics: 'topic'
}

exports.types = {
  contacts: ['entity:klout/influencees']
}
