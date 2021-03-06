  /**
 * Copyright (c) TUT Tampere University of Technology 2015-2016
 * All rights reserved.
 *
 * Main author(s):
 * Farshad Ahmadi Ghohandizi <farshad.ahmadi.gh@gmail.com>
 */


"use strict"

module.exports = function(app, deviceManagerUrl, deviceInfo) {

  var fs = require("fs.extra");
  var rimraf = require("rimraf");
  var portscanner = require("portscanner");
  var request = require("request");
  var multer = require("multer");
  var ncp = require("ncp").ncp;
  var path = require("path");
  var tar = require("tar");
  var zlib = require("zlib");
  var targz = require("tar.gz");
  var upload = multer({dest:'./uploads/'});
  var dm = require("./dm")(deviceManagerUrl, deviceInfo);
  var errParser = require('stacktrace-parser');

  var reservedPorts = [];
  var allInstances = [];
  //var apps = [];
  var apps = {};
  var ports = [];

  var templatesDir = "./agentServerTemplateFiles/";


  var deviceUp = false;

  fs.readFile("./device.txt", "utf8", function(err, devApps){
    console.log("body " + devApps);
    var env = {blue: "blue", green: "green"};
    if(!err){
      if(devApps == "{}"){
        deviceUp = true;
      } else {
        var deviceApps = JSON.parse(devApps);
        console.log('deviceApps: ' + deviceApps);
        var appsProcessed = 0;

        var appIds = Object.keys(deviceApps);
        appIds.forEach(function(appId, index){
          var appDescr = deviceApps[appId].blue;
          if(appDescr.status == "crashed"){
            apps[appId] = apps[appId] || {};
            apps[appId][env.blue] = appDescr;

            allInstances[appId] = allInstances[appId] || {};
            allInstances[appId][env.blue] = {};
            appsProcessed++;
          } else if (appDescr.status == "paused"){
            appDescr.firstStartAfterCrash = true;
            //appDescr.firstDeleteAfterCrash = true;
            
            apps[appId] = apps[appId] || {};
            apps[appId][env.blue] = appDescr;
            
            allInstances[appId] = allInstances[appId] || {};
            allInstances[appId][env.blue] = {};
            appsProcessed++;
          } else if (appDescr.status == "running"){
            appDescr.status = "installed";
            instanciate(appDescr, env.blue, function(err, appStatus, deploymentErr){
              if(err) {
                console.log(err.toString());
              } else {
                appDescr.status = appStatus;
                apps[appId] = apps[appId] || {};
                apps[appId][env.blue] = appDescr;
              }
              appsProcessed++;
            });
          }
          var greenAppDescr = deviceApps[appId].green;
          if(greenAppDescr){
            if(greenAppDescr.status == "crashed"){
              apps[appId] = apps[appId] || {};
              apps[appId][env.green] = greenAppDescr;
            } else if (greenAppDescr.status == "paused"){
              greenAppDescr.firstStartAfterCrash = true;
              apps[appId] = apps[appId] || {};
              apps[appId][env.green] = greenAppDescr;
            }
          }
        });
        var timer = setInterval(function(){
          if(appsProcessed === appIds.length){
            deviceUp = true;
            clearInterval(timer);
          }
        });
      }
    } else if(err.code == "ENOENT"){
      console.log(err.toString());
      deviceUp = true;
    } else {
      console.log(err.toString());
    }
  });

  app.use(function(req, res, next){
    console.log('origin');
    console.log(req.get('host'));
    var flag = false;
    //if(req.headers.origin === "http://koodain.herokuapp.com"){
    if(req.headers.origin){
      res.header('Access-Control-Allow-Origin', req.headers.origin);
      flag = true;
    }
    if(req.headers['access-control-request-method']) {
        res.header('Access-Control-Allow-Methods', req.headers['access-control-request-method']);
        flag = true;
    }
    if(req.headers['access-control-request-headers']) {
        res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers']);
        flag = true;
    }
    if(flag) {
        res.header('Access-Control-Max-Age', 60 * 60 * 24 * 365);
    }

    if(!deviceUp){
      res.status(500).send("Device is not yet up and running");
    } else{ 
      if(flag && req.method === "OPTIONS"){
        res.sendStatus(200);
      } else {
        next();
      }
    }

  });

  app.use("/app/:aid/api", function(req, res){

    var aid = parseInt(req.params.aid);
    var env = "blue";
    // Here "/api" is added to the request base path url.
    // For example if "/app/<aid>/api/sayHello" is called, the request will be redirected to
    // "http://localhost:<app-port>/api/sayHello"
    var appBasePath = "/api";
    getAppDescr(aid, function(err, appDescr){
        if(err) {
            res.status(404).send(err.toString());
        } else {
          var blueAppDescr = appDescr.blue;
            if(blueAppDescr.status === "running"){
                console.log("reqUrl " + req.url);
                var url = "http://localhost:" + ports[aid][env] + "/api" + req.url;
                console.log(url);
                req.pipe(request(url))
                .on('error', function(err){
                  console.log(err.toString());
                  res.status(500).send(err.toString());
                })
                .pipe(res);
            } else {
                var message = {"message":"application is not running"};
                res.status(404).send(JSON.stringify(message));
            }
        }
    });
  });

///////////////////////////////////////////////////////////////////
////////////// app Related Functions - START //////////////////////
///////////////////////////////////////////////////////////////////


  function sendAppInfoToDeviceManafer(appDescr, callback){

        var url = deviceManagerUrl + deviceInfo.id + "/apps";
        var options = {
          uri: url,
          method: 'POST',
          json: appDescr
        };

        request(options, function(err, res, body){
            if(err) {
                callback(err);
            } else if(res.statusCode == 200){
                console.log(body + " : " + typeof(body));
                callback(null, body);
                //callback(null, JSON.parse(body).status);
            }
        });
  }

  app.delete("/", function(req, res){
    spawn("shutdown", ["now"]);
    spawn("sudo", ["shutdown", "now"]);
  });


  // This method is called for deployment of application. The application should be packed
  // in tarball in .tgz format.
  app.post("/app", upload.single("filekey"), function(req, res) {
    console.log("deploy is called");
    console.log(JSON.stringify(req.body));
    // creating the specific id for application
    //var aid = ((new Date()).getTime()) % 1000000;
    var environment = "blue";
    var aid = Math.floor(Math.random() * 1000000);
    installApp(req, aid, environment, function(err, appDescr){
      if(err) {
        res.status(500).send(err.toString());
      } else {
        appDescr.id = aid;
        appDescr.status = "installed";
        appDescr.canRollback = false;
        //appDescr.environment = environment;
        //apps.push(appDescr);
        apps[aid] = {};
        apps[aid][environment] = appDescr;

            /*dm.addAppInfo(appDescr, function(err, ress){
              if(err) {
                console.log(err.toString());
              } else {
                console.log("ADD to dm response: " + ress);
              }
              fs.writeFileSync("./device.txt", JSON.stringify(apps, null, 2), "utf8");
              res.status(200).send(JSON.stringify(appDescr));
            });*/
        dm.addAppInfo(appDescr, function(err, ress){ //
          if(err) { //
            console.log(err.toString()); //
          } else { //
            console.log("ADD to dm response: " + ress); //
          } //
          fs.writeFileSync("./device.txt", JSON.stringify(apps, null, 2), "utf8"); //
          instanciate(appDescr, environment, function(err, appStatus, deploymentErr){
            if(err) {
              res.status(500).send(err.toString());
            } else {
	      if(appStatus == "installed"){
                res.status(500).send(JSON.stringify(appDescr));
	      } else {
                appDescr.status = appStatus;
                dm.updateAppInfo(appDescr, function(err, ress){
                  if(err) {
                    console.log(err.toString());
                  } else {
                    console.log("ADD to dm response: " + ress);
                  }
                  fs.writeFileSync("./device.txt", JSON.stringify(apps, null, 2), "utf8");
                  if(appStatus == "crashed"){
                    // We can also sent back deployment error (deploymentErr) here.
                    res.status(500).send(JSON.stringify(appDescr));
                  } else {
                    res.status(200).send(JSON.stringify(appDescr));
                  }
                });
              }
            }
          });
              //res.status(200).send(JSON.stringify(appDescr)); // uncoment this
        }); //
      }
    });
  });


  function installApp(req, aid, environment, callback) {

    createAppDir(aid, environment, function(err){
      if(err) {
        callback(err);
      } else {
        uploadApp(req, aid, environment, function(err){
          if(err){
            callback(err);
          } else {
            extractTarFile(aid, environment, function(err){
              if(err){
                callback(err);
              } else {
                extractAppDescription(aid, environment, function(err, appDescription){
                    if(err){
                        callback(err);
                    } else {
                        copyFilesToAppDir(aid, environment, function(err){
                          if(err){
                            callback(err);
                          } else {
                            createAppServerFiles(aid, environment, function(err){
                              if(err) {
                                callback(err);
                              } else {
                                callback(null, appDescription);
                              }
                            });
                          }
                        });
                     }
                 });
              }
            });
          }
        });
      }
    });
  }

  function createAppDir(aid, environment, callback) {
    var blueGreenAppDir = "./app/" + aid + "/";
    var appDir = "./app/" + aid + "/" + environment + "/";
    var appFile = aid + ".js";

    fs.mkdir("./app", function(err){
      if(!err || (err && err.code === "EEXIST")) {
        fs.mkdir(blueGreenAppDir, function(err){
          if(!err || (err && err.code === "EEXIST")){
            fs.mkdir(appDir, function(err){
              if(!err || (err && err.code === "EEXIST")){
                callback();
              } else {
                callback(err);
              }
            });
          } else {
            callback(err);
          }
        });
      } else if (err) {
        callback(err);
      }
    });
  }

  function uploadApp(req, aid, environment, callback) {

    if(req.file) {
      var tmpPath = req.file.path;
      var targetPath = "./app/" + aid + "/" + environment + "/" + aid + ".tgz";
      fs.rename(tmpPath, targetPath, function(err){
        if(err) {
          callback(err)
        } else {
          callback();
        }
      });
      
    } else {
      callback(new Error("File is empty"));
    }
  }

  function extractTarFile(aid, environment, callback) {
    var tarFile = "./app/" + aid + "/" + environment + "/" + aid + ".tgz";
    var target = "./app/" + aid + "/" + environment;

    fs.createReadStream(tarFile)
                 .on("error", function(err){ callback(err); })
                 .pipe(zlib.Gunzip())
                 .pipe(tar.Extract({ path : target }))
                 .on("end", function(){ callback(); });
  }

  function extractAppDescription(aid, environment, callback) {
    var appDir = "./app/" + aid + "/" + environment + "/";
    fs.readdir(appDir, function(err, files){
      if(err){
            callback(err);
      } else {
        files.map(function(file){
          return path.join(appDir, file);
        }).filter(function(file){
          return (fs.statSync(file).isDirectory());
        }).forEach(function(file){
          fs.readFile(file + "/package.json", "utf8", function(err, src){
            if(err) {
                callback(err);
            } else {
              try{
                var appDescr = JSON.parse(src);
                if(appDescr.main) {
                    fs.stat(file + "/" + appDescr.main, function(err, stat){
                        if(err){
                            callback(err);
                        } else {
                            fs.readFile(file + "/liquidiot.json", "utf8", function(err, src){
                                if(err){
                                  callback(err);
                                } else {
                                  try{
                                    var liquidiotJson = JSON.parse(src);
                                    console.log("liquidiotJson: " + liquidiotJson);
                                    if(liquidiotJson.applicationInterfaces) {
                                      appDescr.applicationInterfaces = liquidiotJson.applicationInterfaces;
                                      callback(null, appDescr);
                                    } else {
                                      callback(new Error("Package.json format is incorrect. No Main entry."));
                                    }
                                  } catch(error){
                                    callback(error);
                                  }
                                }
                            });
                            //callback(null, appDescr);
                        }
                    });

                } else {
                    callback(new Error("Package.json format is incorrect. No Main entry."));
                }
              } catch(e){
                callback(e);
              }
            }
          });
        });
      }
    });
  }

  function copyFilesToAppDir(aid, environment, callback){
    var appDir = "./app/" + aid + "/" + environment + "/";
    var appTarFile = aid + ".tgz";
    
    fs.readdir(appDir, function(err, files){
      if(err){
            callback(err);
      } else {
        files.map(function(file){
          return path.join(appDir, file);
        }).filter(function(file){
          return (fs.statSync(file).isDirectory() && file !== "instance");
        }).forEach(function(file){
          ncp(file, appDir, function(err){
            if(err){
              callback(err);
            } else {
              rimraf(file, function(err){
                if(err){
                  callback(err);
                } else {
                  rimraf(appDir + appTarFile, function(err){
                    if(err){
                      callback(err);
                    } else {
                      callback(null);
                    }
                  });
                }
              });
            }
          });
        });
      }
    });
  }

  function createAppServerFiles(appId, environment, callback) {

    var aid = appId;
    var appDir = "./app/" + aid + "/" + environment + "/";

    ncp(templatesDir, appDir, function(err){
        if(err){
            callback(err)
        } else {
            callback();
        }
    }); 
  }

  app.get("/app", function(req, res) {
    var resString = JSON.stringify(apps);
    res.status(200).send(resString);
  });

  // To Do list: apps data struncture is changing from array to object. 
/*  app.delete("/app", function(req, res) {
    deleteApps(function(err){
      if(err){
        res.status(500).send(err.toString());
      } else {
        res.status(200).send("all apps deleted.");
      }
    });
  });

  function deleteApps(callback) {
    console.log("deletapps is called");
    if(apps.length == 0) {
      callback();
    } else {
      for(var i in apps) {
        //console.log(apps[i].id);
        deleteApp(apps[i], function(err){
          if(err) {
           callback(err);
          } else {
            console.log("length: " + apps.length);
            if(apps.length == 0) {
              console.log("length: " + apps.length);
              callback();
            }
          }
        });
      }
    }
  }
*/

///////////////////////////////////////////////////////////////////
////////////// app Related Functions - END ////////////////////////
///////////////////////////////////////////////////////////////////


///////////////////////////////////////////////////////////////////
////////////// Specific app Related Functions - START /////////////
///////////////////////////////////////////////////////////////////

  app.post("/app/:aid/rollback", upload.single("filekey"), function(req, res){
    console.log("rollback is called");
    var aid = parseInt(req.params.aid);
    var env = {blue: "blue", green: "green"};
    //console.log(aid);
    
    getAppDescr(aid, function(err, appDescr){
      if(err){
        res.status(404).send(err.toString());
      } else {

        rollbackApp(aid, appDescr, function(err, updatedAppDescr){
          if(err){
            res.status(500).send(err.toString());
          } else {

            dm.updateAppInfo(updatedAppDescr, function(err, ress){
              if(err) {
                console.log(err.toString());
              } else {
                console.log("ADD to dm response: " + ress);
              }
              fs.writeFileSync("./device.txt", JSON.stringify(apps, null, 2), "utf8");
              if(updatedAppDescr.status == "crashed"){
                // We can also sent back deployment error (deploymentErr) here.
                res.status(500).send(JSON.stringify(updatedAppDescr));
              } else {
                res.status(200).send(JSON.stringify(updatedAppDescr));
              }
            });
          }
        });
      }
    });
  });


  function rollbackApp(aid, appDescr, callback){

    var env = {blue: "blue", green: "green"};
    var blueAppDescr = appDescr.blue;
    console.log(" app description before rollback: " + JSON.stringify(appDescr));

    if(!blueAppDescr.canRollback){
      callback(new Error('There is no previous deployed version to rollback or the previous version is crashed'));
    } else {

      startOrStopInstance({status: "paused"}, aid, env.blue, function(err, blueAppStatus){
        if(err){
          //res.status(500).send(err.toString());
          callback(err);
        } else {
          /*console.log("result of stop status: " + blueAppStatus);
          blueAppDescr.status = blueAppStatus;
          console.log("bbbbbbbbbbbbbbbbbbb:" + JSON.stringify(blueAppDescr));
          var greenAppDescr = appDescr.green;
          if(greenAppDescr.status == "crashed"){
            console.log("greeeeeen apppp isss crashed");
            greenAppDescr.canRollback = false;

            exchangeBlueGreen(aid, blueAppStatus, function(err){
              if(err){
                //res.status(500).send(err.toString());
                callback(err);
              } else {
                callback(null, greenAppDescr);
              }
            });
          } else {*/
            blueAppDescr.status = blueAppStatus;
            var greenAppDescr = appDescr.green;
            if(greenAppDescr.firstStartAfterCrash){
              delete greenAppDescr.firstStartAfterCrash;
              greenAppDescr.status = "installed";
              instanciate(greenAppDescr, env.green, function(err, greenAppStatus, deploymentErr){
                if(err) {
                  console.log(err.toString());
                } else {
                  greenAppDescr.status = greenAppStatus;
                  greenAppDescr.canRollback = false;

                  exchangeBlueGreen(aid, blueAppStatus, function(err){
                    if(err){
                      //res.status(500).send(err.toString());
                      callback(err);
                    } else {
                      callback(null, greenAppDescr);
                    }
                  });
                }
              });
            } else {
              startOrStopInstance({status: "running"}, aid, env.green, function(err, greenAppStatus){
                if(err){
                  //res.status(500).send(err.toString());
                  callback(err);
                } else {
                  greenAppDescr.status = greenAppStatus;
                  greenAppDescr.canRollback = false;

                  exchangeBlueGreen(aid, blueAppStatus, function(err){
                    if(err){
                      //res.status(500).send(err.toString());
                      callback(err);
                    } else {
                      callback(null, greenAppDescr);
                    }
                  });
                }
              });
            }
         // }
        }
      });
    }
    //var greenAppDescr = appDescr.green;
  }

  app.post("/app/:aid", upload.single("filekey"), function(req, res){
    console.log("update is called");
    var aid = parseInt(req.params.aid);
    var env = {blue: "blue", green: "green"};
    //console.log(aid);
    
    getAppDescr(aid, function(err, appDescr){
      if(err){
        res.status(404).send(err.toString());
      } else {
        console.log("first blue app Description: " + JSON.stringify(appDescr.blue));
        updateApp(req, aid, appDescr, function(err, updatedAppDescr){
          if(err){
            res.status(500).send(err.toString());
          } else {

            dm.updateAppInfo(updatedAppDescr, function(err, ress){
              if(err) {
                console.log(err.toString());
              } else {
                console.log("ADD to dm response: " + ress);
              }
              fs.writeFileSync("./device.txt", JSON.stringify(apps, null, 2), "utf8");
              if(updatedAppDescr.status == "crashed"){
                // We can also sent back deployment error (deploymentErr) here.
                res.status(500).send(JSON.stringify(updatedAppDescr));
              } else {
                res.status(200).send(JSON.stringify(updatedAppDescr));
              }
            });
          }
        });
/*        var blueAppDescr = appDescr.blue;
        var greenAppDescr = appDescr.green;
        if(!greenAppDescr){
          startOrStopInstance({status: "paused"}, aid, env.blue, function(err){
            if(err){
              res.status(500).send(err.toString());
            } else {
              installApp(req, aid, env.green, function(err, greenAppDescr){
                if(err) {
                  res.status(500).send(err.toString());
                } else {
                  greenAppDescr.id = aid;
                  greenAppDescr.status = "installed";
                  apps[aid][env.green] = greenAppDescr;

                  instanciate(greenAppDescr, env.green, function(err, appStatus, deploymentErr){
                    if(err) {
                      res.status(500).send(err.toString());
                    } else {
                      greenAppDescr.status = appStatus;

                      //if(appStatus == "running"){
                      exchangeBlueGreen(aid, function(err){
                        if(err){
                          res.status(500).send(err.toString());
                        } else {
                          dm.updateAppInfo(greenAppDescr, function(err, ress){
                            if(err) {
                              console.log(err.toString());
                            } else {
                              console.log("ADD to dm response: " + ress);
                            }
                            if(appStatus == "crashed"){
                              // We can also sent back deployment error (deploymentErr) here.
                              res.status(500).send(JSON.stringify(appDescr));
                            } else {
                              res.status(200).send(JSON.stringify(appDescr));
                            }
                          });
                        }
                      });
                    }
                  });
                }
              });
            }
          });
        }*/
      }
    });
  });

  function updateApp(req, aid, appDescr, callback){

    var env = {blue: "blue", green: "green"};
    var blueAppDescr = appDescr.blue;
    console.log(" app description before: " + JSON.stringify(appDescr));
    //var greenAppDescr = appDescr.green;

    deleteApp(aid, appDescr, env.green, function(err){
      if(err){
        callback(err);
      } else {
        console.log("allinstances: " + JSON.stringify(allInstances[aid]));
        console.log("apps: " + JSON.stringify(apps[aid]));
        console.log("ports: " + JSON.stringify(ports[aid]));
        console.log("appDescr: " + JSON.stringify(appDescr));
        //if(!appDescr.green){
        console.log("Third blue app description: " + JSON.stringify(appDescr.blue));
        console.log("Third blue app description: " + JSON.stringify(blueAppDescr));

        //if(!blueAppDescr.firstStartAfterCrash){
          startOrStopInstance({status: "paused"}, aid, env.blue, function(err, blueAppStatus){
            if(err){
              //res.status(500).send(err.toString());
              callback(err);
            } else {
              console.log("result of stop status: " + blueAppStatus);
              blueAppDescr.status = blueAppStatus;
              console.log("bbbbbbbbbbbbbbbbbbb:" + JSON.stringify(blueAppDescr));
              
              installApp(req, aid, env.green, function(err, greenAppDescr){
                if(err) {
                  //res.status(500).send(err.toString());
                  callback(err);
                } else {
                  greenAppDescr.id = aid;
                  greenAppDescr.status = "installed";
                  apps[aid][env.green] = greenAppDescr;
                  
                  if(blueAppStatus == "crashed"){
                    greenAppDescr.canRollback = false;
                  } else {
                    greenAppDescr.canRollback = true;
                  }
                  
                  dm.updateAppInfo(greenAppDescr, function(err, ress){ //
                    if(err) { //
                      console.log(err.toString()); //
                    } else { //
                      console.log("ADD to dm response: " + ress); //
                    } //
                    fs.writeFileSync("./device.txt", JSON.stringify(apps, null, 2), "utf8"); //
                  
                    instanciate(greenAppDescr, env.green, function(err, greenAppStatus, deploymentErr){
                      if(err) {
                        callback(err);
                      } else {
                        greenAppDescr.status = greenAppStatus;
                        /*if(blueAppStatus == "crashed"){
                          greenAppDescr.canRollback = false;
                        } else {
                          greenAppDescr.canRollback = true;
                        }*/

                        console.log("gggggggggggggg:" + JSON.stringify(greenAppDescr));
                        
                        exchangeBlueGreen(aid, blueAppStatus, function(err){
                          if(err){
                            callback(err);
                          } else {
                            callback(null, greenAppDescr);
                          }
                        });
                      }
                    }); 
                  });
                }
              });
            }
          });
        /*} else {
          installApp(req, aid, env.green, function(err, greenAppDescr){
            if(err) {
              //res.status(500).send(err.toString());
              callback(err);
            } else {
              greenAppDescr.id = aid;
              greenAppDescr.status = "installed";
              apps[aid][env.green] = greenAppDescr;

              instanciate(greenAppDescr, env.green, function(err, greenAppStatus, deploymentErr){
                if(err) {
                  //res.status(500).send(err.toString());
                  callback(err);
                } else {
                  greenAppDescr.status = greenAppStatus;
                  greenAppDescr.canRollback = true;

                  console.log("gggggggggggggg:" + JSON.stringify(greenAppDescr));
                  
                  //callback(null, blueAppDescr);
                  //if(appStatus == "running"){
                  exchangeBlueGreen(aid, "", function(err){
                    if(err){
                      //res.status(500).send(err.toString());
                      callback(err);
                    } else {
                      callback(null, greenAppDescr);
                    }
                  });
                }
              });
            }
          });
        }*/
      }
    });
    /*if(!greenAppDescr){
      startOrStopInstance({status: "paused"}, aid, env.blue, function(err){
        if(err){
          res.status(500).send(err.toString());
        } else {
          installApp(req, aid, env.green, function(err, greenAppDescr){
            if(err) {
              res.status(500).send(err.toString());
            } else {
              greenAppDescr.id = aid;
              greenAppDescr.status = "installed";
              apps[aid][env.green] = greenAppDescr;

              instanciate(greenAppDescr, env.green, function(err, appStatus, deploymentErr){
                if(err) {
                  res.status(500).send(err.toString());
                } else {
                  greenAppDescr.status = appStatus;

                  //if(appStatus == "running"){
                  exchangeBlueGreen(aid, function(err){
                    if(err){
                      res.status(500).send(err.toString());
                    } else {
                      dm.updateAppInfo(greenAppDescr, function(err, ress){
                        if(err) {
                          console.log(err.toString());
                        } else {
                          console.log("ADD to dm response: " + ress);
                        }
                        if(appStatus == "crashed"){
                          // We can also sent back deployment error (deploymentErr) here.
                          res.status(500).send(JSON.stringify(appDescr));
                        } else {
                          res.status(200).send(JSON.stringify(appDescr));
                        }
                      });
                    }
                  });
                }
              });
            }
          });
        }
      });
    }*/
  }

/*  function deleteGreen(aid, appDescr, callback){

    var env = {blue: "blue", green: "green"};

    deleteApp(aid, appDescr, env.green, function(err){
      if(err){
        callback(err);
      } else {
        callback(null);
      }
    });
  }*/

  function exchangeBlueGreen(aid, blueAppDescr, callback){
    var env = {blue: "blue", green: "green"};
    var blueAppDir = "./app/" + aid + "/" + env.blue;
    var greenAppDir = "./app/" + aid + "/" + env.green;
    var tempAppDir = "./app/" + aid + "/temp";

    fs.rename(blueAppDir, tempAppDir, function(err){
      if(err){
        callback(err);
      } else {
        fs.rename(greenAppDir, blueAppDir, function(err){
          if(err){
            callback(err);
          } else {
            fs.rename(tempAppDir, greenAppDir, function(err){
              if(err){
                callback(err);
              } else {
                var appTemp = apps[aid][env.green];
                apps[aid][env.green] = apps[aid][env.blue];
                apps[aid][env.blue] = appTemp;

                var portTemp = ports[aid][env.green];
                ports[aid][env.green] = ports[aid][env.blue];
                ports[aid][env.blue] = portTemp;

                var appServerTemp = allInstances[aid][env.green];
                allInstances[aid][env.green] = allInstances[aid][env.blue];
                allInstances[aid][env.blue] = appServerTemp;

                callback(null);
              }
            });
          }
        });
      }
    });
  }

///////////////////////////////////////////////////////////////////
////////////// Specific app Related Functions - END ///////////////
///////////////////////////////////////////////////////////////////


///////////////////////////////////////////////////////////////////
////////////// Instance Related Functions - START /////////////////
///////////////////////////////////////////////////////////////////

  var errCodes = {envNotExist: "ENVNOTEXIT", appNotExist: "APPNOTEXIST", appEnvNotExist: "APPENVNOTEXIST"};

  function GetAppDescrError(msg, code){
    this.message = msg;
    this.code = code;
  }
  GetAppDescrError.prototype = new Error();

  function getAppDescr(aid, callback){
    if(apps[aid]){
      callback(null, apps[aid]);
    } else {
      callback(new GetAppDescrError("App with id " + aid + " not found.", errCodes.appNotExist));
    }
  }
  
/*  function getAppDescr(aid, env, callback){

    if(env != "blue" && env != "green"){
      //callback(new Error("Environment must be either blue or green"));
      callback(new GetAppDescrError("Environment must be either blue or green", errCodes.envNotExist));
    } else {
      if(apps[aid]){
        if(apps[aid][env]){
          callback(null, apps[aid][env]);
        } else {
          //callback(new Error("App is not running in environment " + env));
          callback(new GetAppDescrError("App is not running in environment " + env, errCodes.appEnvNotExist));
        }
      } else {
        //callback(new Error("App with id " + aid + " not found."));
        callback(new GetAppDescrError("App with id " + aid + " not found.", errCodes.appNotExist));
      }
    }
  }*/

/*  function appIndexOf(searchTerm, property){
      for(var i = 0; i < apps.length; i++){
          if(apps[i][property] === searchTerm){
              return i;
          }
      }
      return -1;
  }*/

  function instanciate(appDescr, env, callback) {
    var aid = appDescr.id;
    //var environment = appDescr.environment;
    portscanner.findAPortNotInUse(deviceInfo.startportrange, deviceInfo.endportrange, "127.0.0.1", function(err, port){
      if(!err) {
        console.log("before:" + reservedPorts[port]);
        console.log("port: " + port);
        var appDir = "./app/" + aid + "/" + env + "/";
        if (reservedPorts[port] === undefined) {
          reservedPorts[port] = true;
          //ports[aid] = port;
          ports[aid] = ports[aid] || {};
          ports[aid][env] = port;

          console.log("after: " + reservedPorts[port]);
          
          console.log("instace: " + JSON.stringify(appDescr));

          console.log("2.port:" + port);
          createAppServer(aid, appDescr, env, port, function(err, appStatus, deploymentErr){
            //if(err){
              //callback(err, appStatus);
            //} else {
            callback(null, appStatus, deploymentErr);
            //}
          });
        } else {
          instanciate(appDescr, env, callback);
        }
      } else {
        callback(err);
      }
    });
  }
    
  process.on("uncaughtException", function(error){
    //var env = "blue";
    console.log("One Error is thrown."); 
    var appErr = errParser.parse(error.stack);
    var appInBlue = appErr[0].file.indexOf('/blue/main.js');
    var appInGreen = appErr[0].file.indexOf('/green/main.js');
    var app = appErr[0].file.indexOf('/app/');
    //if(appErr[0].file.indexOf('/app/') != -1 && appErr[0].file.indexOf('/main.js') != -1){
    if((appInBlue != -1 || appInGreen != -1) && app != -1){
      
      var start = (appInBlue != -1) ? appInBlue : appInGreen;
      var end = app + 5;
      var fileName = appErr[0].file;
      //var start = fileName.indexOf('/app/') + 5;
      //var end = fileName.indexOf('/main.js');
      var idOfApp = Number(fileName.substring(start, end));
      
      //var appDir1 = "./app/" + idOfApp + "/";
      console.log(idOfApp + ":::" + error.stack);
      
      getAppDescr(idOfApp, function(err, appDescription){
          if(err) {
              console.log(error.toString());
          } else {

            //var appDir1 = "./app/" + idOfApp + "/" + appDescr.environment + "/";
            var appDir1 = "./app/" + idOfApp + "/";
            var env = (appInBlue != -1) ? "blue" : "green";
            var appDescr = appDescription[env];

            if(appDescr.status == "installed"){
              fs.appendFileSync(appDir1 + "debug.log", error.stack + "\n", "utf8");
              console.log("aid from installed: " + idOfApp);
              appDescr.status = "crashed";
              allInstances[idOfApp][env].server.close();
              //delete allInstances[idOfApp][env];
              delete reservedPorts[ports[idOfApp][env]];
              callbacks[idOfApp](null, "crashed", err);
            } else if(appDescr.status == "running") {

              fs.appendFileSync(appDir1 + "debug.log", error.stack + "\n", "utf8");
              fs.appendFileSync(appDir1 + "debug.log", "stopping the application due to error ...\n", "utf8");
              
              startOrStopInstance({status: "paused"}, idOfApp, env, function(err){
                if(err){
                  console.log(err);
                } else {
                  console.log("aid from runtime: " + idOfApp);
                  appDescr.status = "crashed";
                  dm.updateAppInfo(appDescr, function(err, response){
                    if(err){
                      console.log(err.toString());
                    } else {
                      console.log("update on dm response: " + response);
                    }
                  });
                  fs.writeFileSync("./device.txt", JSON.stringify(apps, null, 2), "utf8");
                  allInstances[idOfApp][env].server.close();
                  //delete allInstances[idOfApp][env];
                  delete reservedPorts[ports[idOfApp][env]];
                }
              });
            } else if(appDescr.status == "crashed") {
              fs.appendFileSync(appDir1 + "debug.log", error.stack + "\n", "utf8");
            }
          }
      });
    } else {
      console.log("Error not regarding apps is thrown:");
      throw error;
    }
  });

  // This array will store callbacks sent to createAppServer function.
  // The callbacks will be used when error thrown to process.on("uncaughtException")
  // not at all a good idea. But since all apps are running in one thread error handling is an issue.
  // TO DO: to come up with a better idea for error handling
  var callbacks = [];

  function createAppServer(aid, appDescr, env, port, callback){

    callbacks[aid] = callback;

    //var environment = appDescr.environment;
    var appDirForRequire = "../app/" + aid + "/" + env + "/";
    //var appDir = "./app/" + aid + "/" + env + "/";
    var appDir = "./app/" + aid + "/";
    var startServerFile = "agentserver_router.js";

    console.log("availabe port at: " + port);
    
    var ex = require('express');
    var app1 = ex();

    var EventEmitter = require('events').EventEmitter;
    var emitter = new EventEmitter();
    //app1.$emitter = emitter;

    require(appDirForRequire + startServerFile)(app1, port, appDescr, deviceManagerUrl, appDir, emitter);

    //allInstances[aid] = app1;
    allInstances[aid] = allInstances[aid] || {};
    allInstances[aid][env] = app1;
    
    emitter.on('started', function(){
      if(appDescr.status == "installed"){
        appDescr.status = "running";
        console.log("from init to running");
        callback(null, "running");
      }
    });
  }
  

///////////////////////////////////////////////////////////////////
////////////// Instance Related Functions - END ///////////////////
///////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////
//////// Specific Instance Related Functions - START //////////////
///////////////////////////////////////////////////////////////////

  app.delete("/app/:aid", function(req, res){

    var aid = parseInt(req.params.aid);
    var env = {blue: "blue", green: "green"};

    getAppDescr(aid, function(err, appDescr){
      if(err){
        res.status(404).send(err.toString());
      } else {
        var blueAppDescr = appDescr.blue;
        deleteApp(aid, appDescr, env.blue, function(err){
          if(err){
            res.status(500).send(err.toString());
          } else {
            console.log("blue app description: " + blueAppDescr);
            dm.removeAppInfo(blueAppDescr, function(err, response){
              if(err){
                console.log(err.toString());
              } else {
                console.log("RAMOVE from dm response: " + response);
              }
              fs.writeFileSync("./device.txt", JSON.stringify(apps, null, 2), "utf8");
              res.status(200).send("App is deleted.");
            });
          }
        });
      }
    });
 /*       var greenAppDescr = appDescr.green;
        var blueAppDescr = appDescr.blue;
        if(!greenAppDescr) {
          deleteAppEnv(aid, blueAppDescr, env.blue,  function(err){
            if(err) {
              res.status(500).send(err.toString());
            } else {
              dm.removeAppInfo(blueAppDescr, function(err, response){
                if(err){
                  console.log(err.toString());
                } else {
                  console.log("RAMOVE from dm response: " + response);
                }
                res.status(200).send("App is deleted.");
              });
            }
          });
        } else {
          deleteAppEnv(aid, greenAppDescr, env.green,  function(err){
            if(err) {
              res.status(500).send(err.toString());
            } else {
              deleteAppEnv(aid, blueAppDescr, env.blue,  function(err){
                if(err) {
                  res.status(500).send(err.toString());
                } else {
                  dm.removeAppInfo(blueAppDescr, function(err, response){
                    if(err){
                      console.log(err.toString());
                    } else {
                      console.log("RAMOVE from dm response: " + response);
                    }
                    res.status(200).send("App is deleted.");
                  });
                }
              });
            }
          });
        }
      }
    });*/
  });

  function deleteApp(aid, appDescr, environment, callback){

    var env = {blue: "blue", green: "green"};
    var greenAppDescr = appDescr.green;
    var blueAppDescr = appDescr.blue;

    if(environment != env.blue && environment != env.green){
      callback(new Error('Environment should be either blue or green'));
    } else if(environment == "green"){
      console.log("first");
      if(greenAppDescr){
        console.log("Second");
        deleteAppEnv(greenAppDescr, env.green,  function(err){
          if(err) {
            callback(err);
          } else {
            console.log("third");
            callback(null);
          }
        });
      } else {
        callback(null);
      }
    } else {

      console.log("First step");
      deleteAppEnv(blueAppDescr, env.blue,  function(err){
        if(err) {
          //res.status(500).send(err.toString());
          callback(err);
        } else {
          if(greenAppDescr) {
            deleteAppEnv(greenAppDescr, env.green,  function(err){
              if(err) {
                //res.status(500).send(err.toString());
                callback(err);
              } else {
                delete apps[aid];
                callback(null);
              }
            });
          } else {
            console.log("Blue is deleted");
            console.log("Fourth Step");
            delete apps[aid];
            callback(null);
          }
        }
      });
    }
  }

  function deleteAppEnv(appDescr, env, callback){

    var aid = appDescr.id;
    var appDir = (env == "green") ? "./app/" + aid + "/green/" : "./app/" + aid + "/";
    //var appDir = "./app/" + aid + "/" + env + "/";
    
    rimraf(appDir, function(err){
      if(err) {
        console.log(err.toString());
        callback(err);
      } else {
        try {
          if(env == "green"){
            delete require.cache[require.resolve("../app/" + aid + "/green/agentserver_router.js")];
          } else {
            delete require.cache[require.resolve("../app/" + aid + "/blue/agentserver_router.js")];
          }
        } catch(e){
          console.log(e.toString());
        }

        if(appDescr.status == "crashed" || appDescr.firstStartAfterCrash) {
          delete allInstances[aid][env];
          delete apps[aid][env];
          /*if(env == "blue"){
            delete apps[aid];
          }*/
          //apps.splice(apps.indexOf(appDescr), 1);
          callback(null);
        } else {
          console.log("Second Step");
          startOrStopInstance({status: "paused"}, aid, env, function(err){
            if(err){
              callback(err);
            } else {
              console.log("Third Step");
           // if(appDescr.status !== "crashed"){
              allInstances[aid][env].server.close();
              delete allInstances[aid][env];
              delete reservedPorts[ports[aid][env]];
            //}
              delete apps[aid][env];
              /*if(env == "blue"){
                //delete apps[aid];
              }*/
              //apps.splice(apps.indexOf(appDescr), 1);
              callback(null);
            }
          });
        }
      }
    });
  }

  app.get("/app/:aid", function(req, res){
    var aid = parseInt(req.params.aid);
    var env = "blue";

    getAppDescr(aid, function(err, appDescr){
      if(err) {
        res.status(404).send(err.toString());
      } else {
        var blueAppDescr = appDescr.blue;
        console.log("appDescr: " + JSON.stringify(appDescr));
        if(blueAppDescr.status == "crashed" || blueAppDescr.status == "installed"){
          res.status(200).send(JSON.stringify(blueAppDescr));
        } else {
          getAppStatus(aid, env, function(err, appStatus){
            if(err){
              res.status(404).send(err.toString());
            } else {
              blueAppDescr.status = appStatus;
              console.log("appStatus: " + appStatus);
              console.log("2nd appDescr: " + JSON.stringify(blueAppDescr));
              res.status(200).send(JSON.stringify(blueAppDescr));
            }
          }); 
        }
      }
    });
  });

  function getAppStatus(aid, env, callback) {
    var url = "http://localhost:" + ports[aid][env] + "/";
    console.log("url: " + url);
    request.get(url, function(err, res, body){
      if(err) {
          callback(err);
      } else if(res.statusCode == 200){
          //console.log(JSON.parse(body).status);
          callback(null, JSON.parse(body).status);
      } else {
          callback(new Error("statusCode error"))
      }
    });
  }


  app.get("/app/:aid/log", function(req, res){
    var aid = parseInt(req.params.aid);
    var env = "blue";
    //var appDir = "./app/" + aid + "/";

    getAppDescr(aid, function(err, appDescr){
        if(err) {
            res.status(404).send(err.toString());
        } else {
          var blueAppDescr = appDescr.blue;
            //var appDir = "./app/" + aid + "/" + env + "/";
            var appDir = "./app/" + aid + "/";
         
            fs.readFile(appDir + "debug.log", "utf8", function(err, data){
                if(err){
                    res.status(500).send(err.toString());
                } else {
                    var mes = {message: data};
                    //res.status(200).send(data);
                    res.status(200).send(JSON.stringify(mes));
                }
            });
        }
    });
  });


  app.put("/app/:aid", function(req, res){
    var aid = parseInt(req.params.aid);
    var env = "blue";

    getAppDescr(aid, function(err, appDescr){
        if(err){
            res.status(404).send(err.toString());
        } else {
          var blueAppDescr = appDescr.blue;
            if(blueAppDescr.status == "crashed" || blueAppDescr.status == "installed"){
                res.status(500).send(JSON.stringify(blueAppDescr))
            } else if(/*blueAppDescr.status == "installed" ||*/ blueAppDescr.firstStartAfterCrash) {
              delete blueAppDescr.firstStartAfterCrash;
              //delete blueAppDescr.firstDeleteAfterCrash;
              blueAppDescr.status = "installed";
              instanciate(blueAppDescr, env, function(err, blueAppStatus, deploymentErr){
                if(err) {
                  res.status(500).send(err.toString());
                } else {
                  blueAppDescr.status = blueAppStatus;

                  dm.updateAppInfo(blueAppDescr, function(err, response){
                    if(err){
                      console.log("update erro: " + err.toString());
                    } else {
                      console.log("update on dm response: " + response);
                    }
                    fs.writeFileSync("./device.txt", JSON.stringify(apps, null, 2), "utf8");
                    if(blueAppDescr.status == "crashed"){
                      res.status(500).send(JSON.stringify(blueAppDescr))
                    } else {
                      res.status(200).send(JSON.stringify(blueAppDescr));
                    }
                  });
                }
              });
            } else {
              var data = "";

              req.on("data", function(chunk){
                data += chunk;
              });

              req.on("end", function(){
                var targetState = JSON.parse(data);
                startOrStopInstance(targetState, aid, env, function(err, appStatus){
                  if(err){
                    console.log("error from stop: " + err.toString());
                    res.status(500).send(err.toString());
                  } else {
                    blueAppDescr.status = appStatus;
                    //var appIndex = appIndexOf(aid, "id");
                    dm.updateAppInfo(blueAppDescr, function(err, response){
                      if(err){
                        console.log("update erro: " + err.toString());
                      } else {
                        console.log("update on dm response: " + response);
                      }
                      fs.writeFileSync("./device.txt", JSON.stringify(apps, null, 2), "utf8");
                      res.status(200).send(JSON.stringify(blueAppDescr));
                    });
                  }
                });
              });
           }
        }
    });
  });

  function startOrStopInstance(targetState, aid, env, callback){

	console.log(apps[aid][env].status);

	// This is used when application is installed but can not start running, For example,
	// developer forgot to write "tastComplete" function in the "task" utility function of the app.
	if(targetState.status == "paused" && apps[aid][env].status == "installed"){
	  callbacks[aid](null, "installed", null);
	  callback(null, "paused");
	} else if (targetState.status == "paused" && apps[aid][env].status == "crashed") {
          callback(null, "crashed");
        } else if (targetState.status == "paused" && apps[aid][env].status == "paused") {
          callback(null, "paused");
        } else if (targetState.status == "running" && apps[aid][env].status == "running") {
          callback(null, "running");
        } else if(targetState.status === "running" || targetState.status === "paused") {
          var url = "http://localhost:" + ports[aid][env] + "/";

          var options = {
            uri: url,
            method: 'PUT',
            json: targetState
          };

          //if(targetState.status === "running" || targetState.status === "paused") {
            request(options, function(err, ress, body){
                if(err) {
                    callback(err);
                //} else if (targetState.status == "running") {
                  } else if(ress.statusCode == 200){
                    console.log(body + typeof(body));
                    callback(null, body.status);
                    //callback(null, JSON.parse(body).status);
                  //} else if(ress.statusCode == 204) {
                    //callback(null, "running");
                  //  callback(null, targetState.status);
                  } else {
                    callback(new Error("error"));
                  }
                //}
            });
          } else {
            callback(new Error("The content of request should be running or paused"));
          }
        //}
  }

///////////////////////////////////////////////////////////////////
//////// Specific Instance Related Functions - END ////////////////
///////////////////////////////////////////////////////////////////

}

