var redis = require('redis');
var Stratum = require('stratum-pool');
var fs = require('fs')
/*
This module deals with handling shares when in internal payment processing mode. It connects to a redis
database and inserts shares with the database structure of:

key: coin_name + ':' + block_height
value: a hash with..
        key:

 */



module.exports = function(logger, poolConfig){
    var _this = this;
    var redisConfig = poolConfig.redis;
    var coin = poolConfig.coin.name;

    this.moniter = '';
    this.blackMembers = [];
    var forkId = process.env.forkId;
    var logSystem = 'Pool';
    var logComponent = coin;
    var logSubCat = 'Thread ' + (parseInt(forkId) + 1);
    
    var lastRedisSync = 0;
    var redisCommands = [];
    
    var connection = redis.createClient(redisConfig.port, redisConfig.host);
    if (redisConfig.password) {
        connection.auth(redisConfig.password);
    }
    connection.on('ready', function(){
        logger.debug(logSystem, logComponent, logSubCat, 'Share processing setup with redis (' + redisConfig.host +
            ':' + redisConfig.port  + ')');
    });
    connection.on('error', function(err){
        logger.error(logSystem, logComponent, logSubCat, 'Redis client had an error: ' + JSON.stringify(err))
    });
    connection.on('end', function(){
        logger.error(logSystem, logComponent, logSubCat, 'Connection to redis database has been ended');
    });
    connection.info(function(error, response){
        if (error){
            logger.error(logSystem, logComponent, logSubCat, 'Redis version check failed');
            return;
        }
        var parts = response.split('\r\n');
        var version;
        var versionString;
        for (var i = 0; i < parts.length; i++){
            if (parts[i].indexOf(':') !== -1){
                var valParts = parts[i].split(':');
                if (valParts[0] === 'redis_version'){
                    versionString = valParts[1];
                    version = parseFloat(versionString);
                    break;
                }
            }
        }
        if (!version){
            logger.error(logSystem, logComponent, logSubCat, 'Could not detect redis version - but be super old or broken');
        }
        else if (version < 2.6){
            logger.error(logSystem, logComponent, logSubCat, "You're using redis version " + versionString + " the minimum required version is 2.6. Follow the damn usage instructions...");
        }
    });
    function blackMemberFilter(shareData){
        for(var i = 0;i < _this.blackMembers.length;i++){
            if(shareData.worker.split(".")[0] === _this.blackMembers[i]){
                return true;
            }
        }
        return false;
    }
    this.addMoniter = function(address){
        this.moniter = address;
    }
    this.removeMoniter = function(){
        this.moniter = '';
    }
    this.addBlackMember = function(address){
        this.blackMembers.push(address)
    }   
	this.getBlackMembers = function(){
        if(process.env.forkId==0){
            fs.unlink('./logs/blackMembers.log', function(err) {
                fs.writeFileSync("./logs/blackMembers.log",_this.blackMembers.join(),{flag:'a'});
            })
        }
        
    }	
	    this.removeBlackMember = function(address){
        var indexToDelete
        for(var i = 0;i < this.blackMembers.length;i++){
            if(address === this.blackMembers[i]){
                indexToDelete = i
            }
        }
        if(indexToDelete!=undefined){
            this.blackMembers.splice(indexToDelete,1);
        }
    }
    this.handleShare = function(isValidShare, isValidBlock, shareData) {

        if (isValidShare) {
            if(!!_this.moniter && shareData.worker.split(".")[0] == _this.moniter){
                connection.zadd(_this.moniter,Date.now(),JSON.stringify(shareData))
            }
            if(blackMemberFilter(shareData)){
                return
            }
            redisCommands.push(['hincrbyfloat', coin + ':shares:roundCurrent', shareData.worker, shareData.difficulty]);
            redisCommands.push(['hincrby', coin + ':stats', 'validShares', 1]);
            

        } else {
            redisCommands.push(['hincrby', coin + ':stats', 'invalidShares', 1]);
        }

        /* Stores share diff, worker, and unique value with a score that is the timestamp. Unique value ensures it
           doesn't overwrite an existing entry, and timestamp as score lets us query shares from last X minutes to
           generate hashrate for each worker and pool. */
        var dateNow = Date.now();
        var hashrateData = [ isValidShare ? shareData.difficulty : -shareData.difficulty, shareData.worker, dateNow];
        redisCommands.push(['zadd', coin + ':hashrate', dateNow / 1000 | 0, hashrateData.join(':')]);

        if (isValidBlock){
            redisCommands.push(['rename', coin + ':shares:roundCurrent', coin + ':shares:round' + shareData.height]);
            redisCommands.push(['rename', coin + ':shares:timesCurrent', coin + ':shares:times' + shareData.height]);
            redisCommands.push(['sadd', coin + ':blocksPending', [shareData.blockHash, shareData.txHash, shareData.height, shareData.worker, dateNow].join(':')]);
            redisCommands.push(['hincrby', coin + ':stats', 'validBlocks', 1]);
            lastRedisSync = 0; // in order to submit data to redis
        }
        else if (shareData.blockHash){
            redisCommands.push(['hincrby', coin + ':stats', 'invalidBlocks', 1]);
        }

        if (Date.now() - lastRedisSync >= 1000) {
            lastRedisSync = Date.now();
            var executionStart = Date.now();
            var executedOperations = redisCommands.length;
            connection.multi(redisCommands).exec(function(err, replies){
                console.log("Share processor Redis execution time: " + (Date.now() - executionStart).toString() + " Executed operations: " + executedOperations.toString());
                if (err)
                logger.error(logSystem, logComponent, logSubCat, 'Error with share processor multi ' + JSON.stringify(err));
            });
            redisCommands = [];
        }
    };

};

