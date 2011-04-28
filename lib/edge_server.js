var ENDING, NOT_SENT, QueuedRequest, RECEIVING_RESP, ResponseCacheValue, SENT, buildCacheValueFromMasterResponse, createServer, defaultContentType, defaultMaxAge, events, fileCache, http, log, masterEndPointOpts, masterReqQueue, mockMasterServer, path, respondFromMasterResponse, tryRespondFromCache, util, writeResponseFromCachedFile;
var __bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; };
http = require('http');
path = require('path');
util = require('util');
events = require('events');
log = util.log;
defaultContentType = 'text/plain';
defaultMaxAge = 60 * 60 * 48;
/*

  hashtable of local files keyed on path
*/
exports.fileCache = fileCache = {};
masterReqQueue = {};
NOT_SENT = 1;
SENT = 2;
RECEIVING_RESP = 3;
ENDING = 4;
QueuedRequest = function() {
  this.status = NOT_SENT;
  return events.EventEmitter.call(this);
};
util.inherits(QueuedRequest, events.EventEmitter);
QueuedRequest.prototype.setStatus = function(status) {
  this.status = status;
  return this.emit('status', status);
};
QueuedRequest.prototype.setRequest = function(req) {
  this.request = req;
  this.status = SENT;
  req.on('response', __bind(function(resp) {
    this.status = RECEIVING_RESP;
    this.emit('receiving', resp);
    return resp.on('end', __bind(function() {
      return this.status = ENDING;
    }, this));
  }, this));
  return this.emit('sent', req);
};
QueuedRequest.prototype.end = function(respValue) {
  return this.emit('end', respValue);
};
ResponseCacheValue = function() {
  this.createDate = Date.now();
  return events.EventEmitter.call(this);
};
util.inherits(ResponseCacheValue, events.EventEmitter);
ResponseCacheValue.prototype.setHead = function(statusCode, headers) {
  var expires, expiresVal, match;
  this.statusCode = statusCode;
  this.headers = headers;
  if (this.headers.connection) {
    delete headers.connection;
  }
  if (!this.headers['cache-control']) {
    if (expiresVal = this.headers['expires']) {
      expires = Date.parse(expiresVal);
      this.ttl = expires - this.createDate;
      this.headers['cache-control'] = "public, max-age=" + (this.ttl / 1000);
    } else {
      this.ttl = defaultMaxAge * 1000;
      this.headers['cache-control'] = "public, max-age=" + defaultMaxAge;
    }
  } else {
    match = this.headers['cache-control'].match(/max-age=(\d+)/i);
    if ((match != null) && typeof match === 'object' && match.length > 1) {
      this.ttl = parseInt(match[1]) * 1000;
    } else {
      this.ttl = defaultMaxAge * 1000;
    }
  }
  if (!this.headers['last-modified']) {
    return this.headers['last-modified'] = (new Date()).toUTCString();
  }
};
ResponseCacheValue.prototype.addChunk = function(chunk) {
  if (!this.chunks) {
    this.chunks = [];
  }
  return this.chunks.push(chunk);
};
ResponseCacheValue.prototype.setComplete = function() {
  return this.emit('complete');
};
/*

  Example:
  var edge = require('edge');
  var edge_server = edge.createServer({
    host: 'yoursite.com',
    port: 80, //defaults to 80
    pathPrefix: '/static', //defaults to '/'
    defaultMaxAge: 60*60*48 //set caching timeout to 48 hours
                            //if it can't be inferred from
                            //origin server request
  });

*/
exports.createServer = createServer = function(masterEndPoint) {
  masterEndPoint.port || (masterEndPoint.port = 80);
  masterEndPoint.pathPrefix || (masterEndPoint.pathPrefix = '/');
  if (masterEndPoint.defaultMaxAge) {
    defaultMaxAge = masterEndPoint.defaultMaxAge;
  }
  http.createServer(function(req, resp) {
    var masterReqOpts, proxReq, queuedReq;
    log("\n" + req.method + " " + req.url + " :");
    log(JSON.stringify(req.headers));
    if (tryRespondFromCache(req, resp)) {
      /* cache hit */
      return;
    }
    /*
      cache miss
      Need to retrieve from master

    */
    /*
       Is this is one already waiting on a respone
    */
    if (queuedReq = masterReqQueue[req.url]) {
      switch (queuedReq.status) {
        case NOT_SENT:
          queuedReq.on('sent', __bind(function(proxReq) {
            return proxReq.on('response', __bind(function(proxResp) {
              return respondFromMasterResponse(resp, proxResp);
            }, this));
          }, this));
          log('cache miss, but NOT_SENT request already in queue');
          break;
        case SENT:
          queuedReq.on('receiving', function(proxResp) {
            return respondFromMasterResponse(resp, proxResp);
          });
          log('cache miss, but already SENT from previous request');
          break;
        case RECEIVING_RESP:
        case ENDING:
          queuedReq.on('end', function(respValue) {
            return writeResponseFromCachedFile(resp, respValue);
          });
          log('cache miss, but RECEIVING_RESP from previous request');
      }
    } else {
      log('cache miss, queuing request');
      queuedReq = new QueuedRequest();
      masterReqQueue[req.url] = queuedReq;
      masterReqOpts = {
        host: masterEndPoint.host,
        port: masterEndPoint.port,
        path: path.join(masterEndPoint.pathPrefix, req.url),
        headers: req.headers
      };
      proxReq = http.get(masterReqOpts, function(proxResp) {
        var cacheValue;
        respondFromMasterResponse(resp, proxResp);
        cacheValue = buildCacheValueFromMasterResponse(proxResp);
        cacheValue.on('complete', function() {
          fileCache[req.url] = cacheValue;
          queuedReq.end(cacheValue);
          return delete masterReqQueue[req.url];
        });
      });
      queuedReq.setRequest(proxReq);
      proxReq.on('error', function(err) {
        log("Error: Could not GET " + masterReqOpts.path + "\n" + (JSON.stringify(err)));
        resp.writeHead(500, {
          'Content-Type': defaultContentType
        });
        resp.end('An error occurred.');
        return err;
      });
    }
  }).listen(8099);
  return log('Server created on 8099');
};
writeResponseFromCachedFile = function(resp, file) {
  var chunk, chunkCount, _i, _len, _ref;
  log("cache hit, " + file.statusCode);
  resp.writeHead(file.statusCode, file.headers);
  log("headers written, " + file.headers);
  chunkCount = 0;
  _ref = file.chunks;
  for (_i = 0, _len = _ref.length; _i < _len; _i++) {
    chunk = _ref[_i];
    resp.write(chunk);
    log("chunk " + (chunkCount++) + " written");
  }
  resp.end();
  log("response ended\n\n");
  return true;
};
tryRespondFromCache = function(req, resp) {
  var dateToCompare, expires, file, lastModified, now;
  file = fileCache[req.url];
  if (typeof file === 'object') {
    if (req.headers['if-modified-since']) {
      debugger;
      dateToCompare = Date.parse(req.headers['if-modified-since']);
      lastModified = Date.parse(file.headers['last-modified']);
      if (lastModified > 0 && dateToCompare > 0 && lastModified <= dateToCompare) {
        log('cache hit, 304');
        resp.writeHead(304, file.headers);
        resp.end();
        return true;
      }
    }
    now = Date.now();
    expires = file.createDate + file.ttl;
    if (now > expires) {
      delete fileCache[req.url];
      return false;
    }
    return writeResponseFromCachedFile(resp, file);
  } else {
    return false;
  }
};
respondFromMasterResponse = function(resp, masterResp) {
  resp.setMaxListeners(200);
  delete masterResp.headers.connection;
  resp.writeHead(masterResp.statusCode, masterResp.headers);
  masterResp.on('data', function(data) {
    return resp.write(data);
  });
  masterResp.on('end', function() {
    return resp.end();
  });
};
buildCacheValueFromMasterResponse = function(masterResp) {
  var cacheValue;
  cacheValue = new ResponseCacheValue();
  cacheValue.setHead(masterResp.statusCode, masterResp.headers);
  masterResp.on('data', function(data) {
    return cacheValue.addChunk(data);
  });
  masterResp.on('end', function() {
    return cacheValue.setComplete();
  });
  return cacheValue;
};
/*

  if this js file is called directly with node with at least one
  extra argument (the host), then we can just call createServer
  Example:
    > node edge_server.js localhost 9000

*/
if (process.argv[1] === __filename && process.argv.length > 2) {
  masterEndPointOpts = {
    host: process.argv[2]
  };
  if (process.argv.length === 4) {
    masterEndPointOpts.port = parseInt(process.argv[3]);
  }
  if (process.argv.length === 5) {
    masterEndPointOpts.pathPrefix = process.argv[4];
  }
  if (process.argv.length === 6) {
    masterEndPointOpts.defaultMaxAge = process.argv[5];
  }
  createServer(masterEndPointOpts);
}
mockMasterServer = http.createServer(function(req, resp) {
  switch (req.url.toLowerCase()) {
    case '/':
    case '/html':
      resp.setHeader('Content-Type', 'text/html');
      resp.writeHead(200);
      return resp.end("<h2>Some awesome content for you to check out \nat " + req.url + ". Oasdfojasd NFALNLDS JDLsldkLSDFJL \nJSALDF JKASJF La sdflkjas sjdlaf jlas. jsaldkfj\nsal flsaj dfljsa lkfj lk LAjl dsafjlaj. You can\ndo it!!! ");
    case '/js':
      resp.writeHead(200, {
        'Content-Type': 'text/javascript',
        'Last-Modified': 'Wed, 09 Aug 1995 00:00:00 GMT'
      });
      return resp.end('(function() { var t= "t"; })();');
    case '/cached':
      resp.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'max-age=3'
      });
      return resp.end("This content was retrieved from master \nat: " + (Date().toString()) + "\n<div> Oasdfojasd NFALNLDS JDLsldkLSDFJL \n  JSALDF JKASJF La sdflkjas sjdlaf jlas. jsaldkfj\n  sal flsaj dfljsa lkfj lk LAjl dsafjlaj. You can\n  do it!!!</div> ");
    case '/backbone.js':
      resp.writeHead(200, {
        'Content-Type': 'application/x-javascript',
        'Last-Modified': 'Wed, 09 Aug 1995 00:00:00 GMT'
      });
      resp.write('// Backbone.js 0.3.3\n// (c) 2010 Jeremy Ashkenas, DocumentCloud Inc.\n// Backbone may be freely distributed under the MIT license.\n// For all details and documentation:\n// http://documentcloud.github.com/backbone\n(function(){var e;e=typeof exports!=="undefined"?exports:this.Backbone={};e.VERSION="0.3.3";var f=this._;if(!f&&typeof require!=="undefined")f=require("underscore")._;var h=this.jQuery||this.Zepto;e.emulateHTTP=false;e.emulateJSON=false;e.Events={bind:function(a,b){this._callbacks||(this._callbacks={});(this._callbacks[a]||(this._callbacks[a]=[])).push(b);return this},unbind:function(a,b){var c;if(a){if(c=this._callbacks)if(b){c=c[a];if(!c)return this;for(var d=0,g=c.length;d<g;d++)if(b===c[d]){c.splice(d,\n1);break}}else c[a]=[]}else this._callbacks={};return this},trigger:function(a){var b,c,d,g;if(!(c=this._callbacks))return this;if(b=c[a]){d=0;for(g=b.length;d<g;d++)b[d].apply(this,Array.prototype.slice.call(arguments,1))}if(b=c.all){d=0;for(g=b.length;d<g;d++)b[d].apply(this,arguments)}return this}};e.Model=function(a,b){a||(a={});if(this.defaults)a=f.extend({},this.defaults,a);this.attributes={};this._escapedAttributes={};this.cid=f.uniqueId("c");this.set(a,{silent:true});this._previousAttributes=\nf.clone(this.attributes);if(b&&b.collection)this.collection=b.collection;this.initialize(a,b)};f.extend(e.Model.prototype,e.Events,{_previousAttributes:null,_changed:false,initialize:function(){},toJSON:function(){return f.clone(this.attributes)},get:function(a){return this.attributes[a]},escape:function(a){var b;if(b=this._escapedAttributes[a])return b;b=this.attributes[a];return this._escapedAttributes[a]=(b==null?"":b).replace(/&(?!\w+;)/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,\n"&quot;")},set:function(a,b){b||(b={});if(!a)return this;if(a.attributes)a=a.attributes;var c=this.attributes,d=this._escapedAttributes;if(!b.silent&&this.validate&&!this._performValidation(a,b))return false;if("id"in a)this.id=a.id;for(var g in a){var i=a[g];if(!f.isEqual(c[g],i)){c[g]=i;delete d[g];if(!b.silent){this._changed=true;this.trigger("change:"+g,this,i,b)}}}!b.silent&&this._changed&&this.change(b);return this},unset:function(a,b){b||(b={});var c={};c[a]=void 0;if(!b.silent&&this.validate&&\n!this._performValidation(c,b))return false;');
      resp.write('delete this.attributes[a];delete this._escapedAttributes[a];if(!b.silent){this._changed=true;this.trigger("change:"+a,this,void 0,b);this.change(b)}return this},clear:function(a){a||(a={});var b=this.attributes,c={};for(attr in b)c[attr]=void 0;if(!a.silent&&this.validate&&!this._performValidation(c,a))return false;this.attributes={};this._escapedAttributes={};if(!a.silent){this._changed=true;for(attr in b)this.trigger("change:"+attr,this,void 0,a);this.change(a)}return this},\nfetch:function(a){a||(a={});var b=this,c=j(a.error,b,a);(this.sync||e.sync)("read",this,function(d){if(!b.set(b.parse(d),a))return false;a.success&&a.success(b,d)},c);return this},save:function(a,b){b||(b={});if(a&&!this.set(a,b))return false;var c=this,d=j(b.error,c,b),g=this.isNew()?"create":"update";(this.sync||e.sync)(g,this,function(i){if(!c.set(c.parse(i),b))return false;b.success&&b.success(c,i)},d);return this},destroy:function(a){a||(a={});var b=this,c=j(a.error,b,a);(this.sync||e.sync)("delete",\nthis,function(d){b.collection&&b.collection.remove(b);a.success&&a.success(b,d)},c);return this},url:function(){var a=k(this.collection);if(this.isNew())return a;return a+(a.charAt(a.length-1)=="/"?"":"/")+this.id},parse:function(a){return a},clone:function(){return new this.constructor(this)},isNew:function(){return!this.id},change:function(a){this.trigger("change",this,a);this._previousAttributes=f.clone(this.attributes);this._changed=false},hasChanged:function(a){if(a)return this._previousAttributes[a]!=\nthis.attributes[a];return this._changed},changedAttributes:function(a){a||(a=this.attributes);var b=this._previousAttributes,c=false,d;for(d in a)if(!f.isEqual(b[d],a[d])){c=c||{};c[d]=a[d]}return c},previous:function(a){if(!a||!this._previousAttributes)return null;return this._previousAttributes[a]},previousAttributes:function(){return f.clone(this._previousAttributes)},_performValidation:function(a,b){var c=this.validate(a);if(c){b.error?b.error(this,c):this.trigger("error",this,c,b);return false}return true}});\ne.Collection=function(a,b){b||(b={});if(b.comparator){this.comparator=b.comparator;delete b.comparator}this._boundOnModelEvent=f.bind(this._onModelEvent,this);this._reset();a&&this.refresh(a,{silent:true});this.initialize(a,b)};f.extend(e.Collection.prototype,e.Events,{model:e.Model,initialize:function(){},toJSON:function(){return this.map(function(a){return a.toJSON()})},add:function(a,b){if(f.isArray(a))for(var c=0,d=a.length;c<d;c++)this._add(a[c],b);else this._add(a,b);return this},remove:function(a,\nb){if(f.isArray(a))for(var c=0,d=a.length;c<d;c++)this._remove(a[c],b);else this._remove(a,b);return this},get:function(a){if(a==null)return null;return this._byId[a.id!=null?a.id:a]},getByCid:function(a){return a&&this._byCid[a.cid||a]},at:function(a){return this.models[a]},sort:function(a){a||(a={});if(!this.comparator)throw Error("Cannot sort a set without a comparator");this.models=this.sortBy(this.comparator);a.silent||this.trigger("refresh",this,a);return this},pluck:function(a){return f.map(this.models,\nfunction(b){return b.get(a)})},refresh:function(a,b){a||(a=[]);b||(b={});this._reset();this.add(a,{silent:true});b.silent||this.trigger("refresh",this,b);return this},fetch:function(a){a||(a={});var b=this,c=j(a.error,b,a);(this.sync||e.sync)("read",this,function(d){b.refresh(b.parse(d));a.success&&a.success(b,d)},c);return this},create:function(a,b){var c=this;b||(b={});if(a instanceof e.Model)a.collection=c;else a=new this.model(a,{collection:c});return a.save(null,{success:function(d,g){c.add(d);\nb.success&&b.success(d,g)},error:b.error})},parse:function(a){return a},chain:function(){return f(this.models).chain()},_reset:function(){this.length=0;this.models=[];this._byId={};this._byCid={}},_add:function(a,b){b||(b={});a instanceof e.Model||(a=new this.model(a,{collection:this}));var c=this.getByCid(a);if(c)throw Error(["Can\'t add the same model to a set twice",c.id]);this._byId[a.id]=a;this._byCid[a.cid]=a;a.collection=this;this.models.splice(this.comparator?this.sortedIndex(a,this.comparator):\nthis.length,0,a);a.bind("all",this._boundOnModelEvent);');
      return resp.end('this.length++;b.silent||a.trigger("add",a,this,b);return a},_remove:function(a,b){b||(b={});a=this.getByCid(a)||this.get(a);if(!a)return null;delete this._byId[a.id];delete this._byCid[a.cid];delete a.collection;this.models.splice(this.indexOf(a),1);this.length--;b.silent||a.trigger("remove",a,this,b);a.unbind("all",this._boundOnModelEvent);return a},_onModelEvent:function(a,b){if(a==="change:id"){delete this._byId[b.previous("id")];this._byId[b.id]=\nb}this.trigger.apply(this,arguments)}});f.each(["forEach","each","map","reduce","reduceRight","find","detect","filter","select","reject","every","all","some","any","include","invoke","max","min","sortBy","sortedIndex","toArray","size","first","rest","last","without","indexOf","lastIndexOf","isEmpty"],function(a){e.Collection.prototype[a]=function(){return f[a].apply(f,[this.models].concat(f.toArray(arguments)))}});e.Controller=function(a){a||(a={});if(a.routes)this.routes=a.routes;this._bindRoutes();\nthis.initialize(a)};var o=/:([\w\d]+)/g,p=/\*([\w\d]+)/g;f.extend(e.Controller.prototype,e.Events,{initialize:function(){},route:function(a,b,c){e.history||(e.history=new e.History);f.isRegExp(a)||(a=this._routeToRegExp(a));e.history.route(a,f.bind(function(d){d=this._extractParameters(a,d);c.apply(this,d);this.trigger.apply(this,["route:"+b].concat(d))},this))},saveLocation:function(a){e.history.saveLocation(a)},_bindRoutes:function(){if(this.routes)for(var a in this.routes){var b=this.routes[a];\nthis.route(a,b,this[b])}},_routeToRegExp:function(a){a=a.replace(o,"([^/]*)").replace(p,"(.*?)");return RegExp("^"+a+"$")},_extractParameters:function(a,b){return a.exec(b).slice(1)}});e.History=function(){this.handlers=[];this.fragment=this.getFragment();f.bindAll(this,"checkUrl")};var l=/^#*/;f.extend(e.History.prototype,{interval:50,getFragment:function(a){return(a||window.location).hash.replace(l,"")},start:function(){var a=document.documentMode;if(a=h.browser.msie&&(!a||a<=7))this.iframe=h(\'<iframe src="javascript:0" tabindex="-1" />\').hide().appendTo("body")[0].contentWindow;\n"onhashchange"in window&&!a?h(window).bind("hashchange",this.checkUrl):setInterval(this.checkUrl,this.interval);return this.loadUrl()},route:function(a,b){this.handlers.push({route:a,callback:b})},checkUrl:function(){var a=this.getFragment();if(a==this.fragment&&this.iframe)a=this.getFragment(this.iframe.location);if(a==this.fragment||a==decodeURIComponent(this.fragment))return false;if(this.iframe)window.location.hash=this.iframe.location.hash=a;this.loadUrl()},loadUrl:function(){var a=this.fragment=\nthis.getFragment();return f.any(this.handlers,function(b){if(b.route.test(a)){b.callback(a);return true}})},saveLocation:function(a){a=(a||"").replace(l,"");if(this.fragment!=a){window.location.hash=this.fragment=a;if(this.iframe&&a!=this.getFragment(this.iframe.location)){this.iframe.document.open().close();this.iframe.location.hash=a}}}});e.View=function(a){this._configure(a||{});this._ensureElement();this.delegateEvents();this.initialize(a)};var q=/^(\w+)\s*(.*)$/;f.extend(e.View.prototype,e.Events,\n{tagName:"div",$:function(a){return h(a,this.el)},initialize:function(){},render:function(){return this},remove:function(){h(this.el).remove();return this},make:function(a,b,c){a=document.createElement(a);b&&h(a).attr(b);c&&h(a).html(c);return a},delegateEvents:function(a){if(a||(a=this.events)){h(this.el).unbind();for(var b in a){var c=a[b],d=b.match(q),g=d[1];d=d[2];c=f.bind(this[c],this);d===""?h(this.el).bind(g,c):h(this.el).delegate(d,g,c)}}},_configure:function(a){if(this.options)a=f.extend({},\nthis.options,a);if(a.model)this.model=a.model;if(a.collection)this.collection=a.collection;if(a.el)this.el=a.el;if(a.id)this.id=a.id;if(a.className)this.className=a.className;if(a.tagName)this.tagName=a.tagName;this.options=a},_ensureElement:function(){if(!this.el){var a={};if(this.id)a.id=this.id;if(this.className)a["class"]=this.className;this.el=this.make(this.tagName,a)}}});var m=function(a,b){var c=r(this,a,b);c.extend=m;return c};e.Model.extend=e.Collection.extend=e.Controller.extend=e.View.extend=\nm;var s={create:"POST",update:"PUT","delete":"DELETE",read:"GET"};e.sync=function(a,b,c,d){var g=s[a];a=a==="create"||a==="update"?JSON.stringify(b.toJSON()):null;b={url:k(b),type:g,contentType:"application/json",data:a,dataType:"json",processData:false,success:c,error:d};if(e.emulateJSON){b.contentType="application/x-www-form-urlencoded";b.processData=true;b.data=a?{model:a}:{}}if(e.emulateHTTP)if(g==="PUT"||g==="DELETE"){if(e.emulateJSON)b.data._method=g;b.type="POST";b.beforeSend=function(i){i.setRequestHeader("X-HTTP-Method-Override",\ng)}}h.ajax(b)};var n=function(){},r=function(a,b,c){var d;d=b&&b.hasOwnProperty("constructor")?b.constructor:function(){return a.apply(this,arguments)};n.prototype=a.prototype;d.prototype=new n;b&&f.extend(d.prototype,b);c&&f.extend(d,c);d.prototype.constructor=d;d.__super__=a.prototype;return d},k=function(a){if(!(a&&a.url))throw Error("A \'url\' property or function must be specified");return f.isFunction(a.url)?a.url():a.url},j=function(a,b,c){return function(d){a?a(b,d):b.trigger("error",b,d,c)}}})();');
    case '/304':
      resp.setHeader(304);
      return resp.end();
    case '/500':
      resp.writeHead(500, {
        'Content-Type': 'text/plain'
      });
      return resp.end('Error');
    default:
      resp.writeHead(404, {
        'Content-Type': 'text/plain'
      });
      return resp.end('Not found');
  }
}).listen(9000);