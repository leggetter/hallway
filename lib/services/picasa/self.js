/*
* Copyright (C) 2012 Singly, Inc. All Rights Reserved.
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*    * Redistributions of source code must retain the above copyright
*      notice, this list of conditions and the following disclaimer.
*    * Redistributions in binary form must reproduce the above copyright
*      notice, this list of conditions and the following disclaimer in the
*      documentation and/or other materials provided with the distribution.
*    * Neither the name of the Locker Project nor the
*      names of its contributors may be used to endorse or promote products
*      derived from this software without specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
* ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
* WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
* DISCLAIMED. IN NO EVENT SHALL THE LOCKER PROJECT BE LIABLE FOR ANY
* DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
* (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
* LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
* ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
* (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
* SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

var request = require('request');

exports.sync = function(pi, cb) {
  var params = {'max-results':0, 'alt':'json'};
  request.get({uri:'https://picasaweb.google.com/data/feed/api/user/default', qs:params, headers:{authorization:'Bearer '+pi.auth.token.access_token, 'GData-Version': 2}, json:true}, function(err, resp, data){
    if(err) return cb(err);
    if(resp.statusCode != 200 || !data || !data.feed) return cb(resp.statusCode+': '+JSON.stringify(data));
    if(!data.feed.gphoto$user || !data.feed.gphoto$user.$t) return cb('missing id: '+JSON.stringify(data.feed));    
    pi.auth.pid = data.feed.gphoto$user.$t+'@picasa';
    pi.auth.profile = data.feed;
    var ret = {};
    ret['profile:'+pi.auth.pid+'/self'] = [data.feed];
    cb(null, {data:ret, auth:pi.auth});
  });
};
