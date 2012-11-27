exports.ptype = 116; // must be unique per service, see dMap.js

exports.authorization = {
  id: function(data){ return data && data.identity && data.identity.id; },
  oembed: function(data) {
    if(!data.identity) return undefined;
    var ret = {type:'contact'};
    ret.title = data.identity.first_name + ' ' + data.identity.last_name;
    ret.email = data.identity.email_address;
    ret.provider_name = '37signals'
    return ret;
  }  
}
exports.defaults = {
  self: 'authorization'
};
