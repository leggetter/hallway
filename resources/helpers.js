var filter = ['facebook/likes', 'stocktwits/users'];
//For filtering out synclets that aren't actually endpoints

exports.listEndpoints = function(service, synclets) {
  var list = [];
  for (var i=0; i<synclets.length; i++) {
    var endpoints = [synclets[i].name];
    if (synclets[i].aka) {
      endpoints = endpoints.concat(synclets[i].aka.split(' '));
    }
    for (var j=0; j<endpoints.length; j++) {
      if (filter.indexOf(service + '/' + endpoints[j]) === -1)
        list.push('"' + endpoints[j] + '"');
    }
  }
  return list.join(',');
};
