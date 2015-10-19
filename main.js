/* jshint -W097 */// jshint strict:false
/* jslint node: true */

"use strict";

var utils        = require(__dirname + '/lib/utils');
var modbus       = require('modbus-stack');
var adapter      = utils.adapter('modbus');
var Binary       = require(__dirname + '/node_modules/modbus-stack/node_modules/bufferlist/binary').Binary;
var Put          = require(__dirname + '/node_modules/modbus-stack/node_modules/put');
var modbusClient = null; //Master
var modbusServer = null; //Slave
var connected    = 0;

var nextPoll;
var ackObjects = {};

process.on('SIGINT', function () {
    if (adapter && adapter.setState) {
        adapter.setState('info.connection', 0, true);
    }
    if (nextPoll)  {
        clearTimeout(nextPoll);
    }
});

adapter.on('ready', function () {
    adapter.setState('info.connection', 0, true);
    main.main();
});

var pulseList  = {};
var sendBuffer = {};
var objects    = {};
var enums      = {};
var infoRegExp = new RegExp(adapter.namespace.replace('.', '\\.') + '\\.info\\.');

adapter.on('stateChange', function (id, state) {
    if (state && !state.ack && id && !infoRegExp.test(id)) {
        if (objects[id]) {
            prepareWrite(id, state);
        } else {
            adapter.getObject(id, function (err, data) {
                if (!err) {
                    objects[id] = data;
                    prepareWrite(id, state);
                }
            });
        }
    }
});

function writeHelper(id, state) {
    sendBuffer[id] = state.val;

    if (Object.keys(sendBuffer).length == 1) send();
}

function prepareWrite(id, state) {
    if (main.acp.slave) {
        var t = typeof state.val;
        if (objects[id].native.type == 'disInputs') {
            if (t === 'boolean' || t === 'number') {
                main.disInputs[objects[id].native.address - main.disInputsLowAddress] = state.val ? 1 : 0;
            } else {
                main.disInputs[objects[id].native.address - main.disInputsLowAddress] = parseInt(state.val, 10) ? 1 : 0;
            }
        } else if (objects[id].native.type == 'coils') {
            if (t === 'boolean' || t === 'number') {
                main.coils[objects[id].native.address - main.coilsLowAddress] = state.val ? 1 : 0;
            } else {
                main.coils[objects[id].native.address - main.coilsLowAddress] = parseInt(state.val, 10) ? 1 : 0;
            }
        } else if (objects[id].native.type == 'inputRegs') {
            if (t === 'boolean') {
                main.inputRegs[objects[id].native.address - main.inputRegsLowAddress] = state.val ? 1 : 0;
            } else if (t === 'number') {
                main.inputRegs[objects[id].native.address - main.inputRegsLowAddress] = state.val;
            } else {
                main.inputRegs[objects[id].native.address - main.inputRegsLowAddress] = parseInt(state.val, 10) ? 1 : 0;
            }
        } else if (objects[id].native.type == 'holdingRegs') {
            if (t === 'boolean') {
                main.holdingRegs[objects[id].native.address - main.holdingRegsLowAddress] = state.val ? 1 : 0;
            } if (t === 'number') {
                main.holdingRegs[objects[id].native.address - main.holdingRegsLowAddress] = state.val;
            } else {
                main.holdingRegs[objects[id].native.address - main.holdingRegsLowAddress] = parseInt(state.val, 10) ? 1 : 0;
            }
        } else {
            adapter.log.error('Unknown state "' + id + '" type: ' + objects[id].native.type);
        }
    } else {
        if (objects[id].native.type == 'coils' || objects[id].native.type == 'holdingRegs') {

            if (!objects[id].native.wp) {

                writeHelper(id, state);
                setTimeout(function () {
                    var _id = id.substring(adapter.namespace.length + 1);
                    adapter.setState(id, ackObjects[_id] ? ackObjects[_id].val : null, true);
                }, main.acp.poll * 1.5);

            } else {
                if (pulseList[id] === undefined) {
                    var _id = id.substring(adapter.namespace.length + 1);
                    pulseList[id] = ackObjects[_id] ? ackObjects[_id].val : !state.val;

                    setTimeout(function () {
                        writeHelper(id, {val: pulseList[id]});

                        setTimeout(function () {
                            if (ackObjects[_id]) {
                                adapter.setState(id, ackObjects[_id].val, true);
                            }
                            delete pulseList[id];
                        }, main.acp.poll * 1.5);

                    }, adapter.config.params.pulsetime);

                    writeHelper(id, state);
                }
            }
        } else {
            setTimeout(function () {
                var _id = id.substring(adapter.namespace.length + 1);
                adapter.setState(id, ackObjects[_id] ? ackObjects[_id].val : null, true);
            }, 0);
        }
    }
}

function send() {
    var id = Object.keys(sendBuffer)[0];

    var type = objects[id].native.type;
    var val  = sendBuffer[id];

    if (type == 'coils') {
        if (val === 'true'  || val === true)  val = 1;
        if (val === 'false' || val === false) val = 0;
        val = parseFloat(val);

        modbusClient.request(modbus.FUNCTION_CODES.WRITE_SINGLE_COIL, objects[id].native.address, val ? true : false, function (err, response) {
            if (err) {
                adapter.log.error(err);
            } else {
                adapter.log.debug('Write successfully [' + objects[id].native.address + ': ' + val);
            }
        });
    } else if (type == 'holdingRegs') {
        val = parseInt(val, 10);
        modbusClient.request(modbus.FUNCTION_CODES.WRITE_SINGLE_REGISTER, objects[id].native.address, val, function (err, response) {
            if (err) {
                adapter.log.error(err);
            } else {
                adapter.log.debug('Write successfully [' + objects[id].native.address + ': ' + val);
            }
        });
    }

    delete(sendBuffer[id]);
    if (Object.keys(sendBuffer).length) {
        setTimeout(send, 0);
    }
}

function addToEnum(enumName, id, callback) {
    adapter.getForeignObject(enumName, function (err, obj) {
        if (!err && obj) {
            var pos = obj.common.members.indexOf(id);
            if (pos == -1) {
                obj.common.members.push(id);
                adapter.setForeignObject(obj._id, obj, function (err) {
                    if (callback) callback(err);
                });
            } else {
                if (callback) callback(err);
            }
        } else {
            if (callback) callback(err);
        }
    });
}

function removeFromEnum(enumName, id, callback) {
    adapter.getForeignObject(enumName, function (err, obj) {
        if (!err && obj) {
            var pos = obj.common.members.indexOf(id);
            if (pos != -1) {
                obj.common.members.splice(pos, 1);
                adapter.setForeignObject(obj._id, obj, function (err) {
                    if (callback) callback(err);
                });
            } else {
                if (callback) callback(err);
            }
        } else {
            if (callback) callback(err);
        }
    });
}

function syncEnums(enumGroup, id, newEnumName, callback) {
    if (!enums[enumGroup]) {
        adapter.getEnum(enumGroup, function (err, _enums) {
            enums[enumGroup] = _enums;
            syncEnums(enumGroup, id, newEnumName, callback);
        });
        return;
    }
    // try to find this id in enums
    var found = false;
    for (var e in enums[enumGroup]) {
        if (enums[enumGroup][e].common &&
            enums[enumGroup][e].common.members &&
            enums[enumGroup][e].common.members.indexOf(id) != -1) {
            if (enums[enumGroup][e]._id != newEnumName) {
                removeFromEnum(enums[enumGroup][e]._id, id);
            } else {
                found = true;
            }
        }
    }
    if (!found && newEnumName) {
        addToEnum(newEnumName, id);
    }
}

var main = {
    oldObjects:             [],
    newObjects:             [],

    disInputs:              [],
    disInputsLowAddress:    0,
    disInputsHighAddress:   0,
    disInputsLength:        0,

    coils:                  [],
    coilsLowAddress:        0,
    coilsHighAddress:       0,
    coilsLength:            0,
    coilsMapping:           [],

    inputRegs:              [],
    inputRegsLowAddress:    0,
    inputRegsHighAddress:   0,
    inputRegsLength:        0,

    holdingRegs:            [],
    holdingRegsLowAddress:  0,
    holdingRegsHighAddress: 0,
    holdingRegsLength:      0,
    holdingRegsMapping:     [],

    history:     "",
    unit:        "",
    errorCount: 0,

    main: function () {
        main.ac        = adapter.config;
        main.acp       = adapter.config.params;
        main.acp.poll  = parseInt(main.acp.poll,  10) || 1000; // default is 1 second
        main.acp.recon = parseInt(main.acp.recon, 10) || 60000;
        main.acp.port  = parseInt(main.acp.port, 10)  || 502;
        main.acp.slave              = parseInt(main.acp.slave, 10)  || 0;

        adapter.config.params.pulsetime = parseInt(adapter.config.params.pulsetime || 1000);

        adapter.getForeignObjects(adapter.namespace + ".*", function (err, list) {

            main.oldObjects = list;

            main.ac.disInputs.sort(sortByAddress);
            main.ac.coils.sort(sortByAddress);
            main.ac.inputRegs.sort(sortByAddress);
            main.ac.holdingRegs.sort(sortByAddress);

            var i;
            var address;

            if (main.ac.disInputs.length) {
                for (i = main.ac.disInputs.length - 1; i >= 0; i--) {
                    address = main.ac.disInputs[i].address;
                    if (address < 0) {
                        adapter.log.error('Invalid discrete inputs address: ' + address);
                        main.ac.disInputs.splice(i, 1);
                        continue;
                    }
                    main.ac.disInputs[i].id = 'discreteInputs.' + address + (main.ac.disInputs[i].name ? '_' + (main.ac.disInputs[i].name.replace('.', '_').replace(' ', '_')) : '');
                }
                if (main.ac.disInputs.length) {
                    main.ac.disInputs.sort(sortByAddress);
                    main.disInputsLowAddress  = Math.floor(main.ac.disInputs[0].address / 16) * 16;
                    main.disInputsHighAddress = main.ac.disInputs[main.ac.disInputs.length - 1].address;
                    main.disInputsLength      = main.disInputsHighAddress - main.disInputsLowAddress + 1;
                    if (main.disInputsLength % 16) main.disInputsLength = (Math.floor(main.disInputsLength / 16) + 1) * 16;
                } else {
                    main.disInputsLength = 0;
                }
            }

            if (main.ac.coils.length) {
                main.coilsLowAddress  = 0xFFFFFFFF;
                main.coilsHighAddress = 0;
                for (i = main.ac.coils.length - 1; i >= 0; i--) {
                    address = main.ac.coils[i].address;

                    if (address < 0) {
                        adapter.log.error('Invalid coils address: ' + address);
                        main.ac.coils.splice(i, 1);
                        continue;
                    }
                    main.ac.coils[i].id = 'coils.' + address + (main.ac.coils[i].name ? '_' + (main.ac.coils[i].name.replace('.', '_').replace(' ', '_')) : '');
                    if (main.acp.slave || main.ac.coils[i].poll) {
                        if (address < main.coilsLowAddress)  main.coilsLowAddress  = address;
                        if (address > main.coilsHighAddress) main.coilsHighAddress = address;
                    }
                }
                if (main.ac.coils.length) {
                    main.ac.coils.sort(sortByAddress);
                    main.coilsLowAddress = Math.floor(main.coilsLowAddress / 16) * 16;
                    main.coilsLength = main.coilsHighAddress - main.coilsLowAddress + 1;
                    if (main.coilsLength % 16) main.coilsLength = (Math.floor(main.coilsLength / 16) + 1) * 16;
                } else {
                    main.coilsLength = 0;
                }
                for (i = 0; i <  main.ac.coils.length; i++) {
                    main.coilsMapping[main.ac.coils[i].address - main.coilsLowAddress] = adapter.namespace + '.' + main.ac.coils[i].id;
                }
            }
            
            if (main.ac.inputRegs.length) {
                for (i = main.ac.inputRegs.length - 1; i >= 0; i--) {
                    address = main.ac.inputRegs[i].address;
                    if (address < 0) {
                        adapter.log.error('Invalid input register address: ' + address);
                        main.ac.inputRegs.splice(i, 1);
                        continue;
                    }
                    main.ac.inputRegs[i].id = 'inputRegisters.' + address + (main.ac.inputRegs[i].name ? '_' + (main.ac.inputRegs[i].name.replace('.', '_').replace(' ', '_')) : '');
                }
                if (main.ac.inputRegs.length) {
                    main.inputRegsLowAddress = main.ac.inputRegs[0].address;
                    main.inputRegsHighAddress = main.ac.inputRegs[main.ac.inputRegs.length - 1].address;
                    main.inputRegsLength = main.inputRegsHighAddress - main.inputRegsLowAddress + 1;
                } else {
                    main.ac.inputRegs.length = 0;
                }
            }

            if (main.ac.holdingRegs.length) {
                main.holdingRegsLowAddress  = 0xFFFFFFFF;
                main.holdingRegsHighAddress = 0;
                for (i = main.ac.holdingRegs.length - 1; i >= 0; i--) {
                    address = main.ac.holdingRegs[i].address;
                    if (address < 0) {
                        adapter.log.error('Invalid holding register address: ' + address);
                        main.ac.holdingRegs.splice(i, 1);
                        continue;
                    }
                    main.ac.holdingRegs[i].id = 'holdingRegisters.' + address + (main.ac.holdingRegs[i].name ? '_' + (main.ac.holdingRegs[i].name.replace('.', '_').replace(' ', '_')) : '');
                    if (main.acp.slave || main.ac.holdingRegs[i].poll) {
                        if (address < main.holdingRegsLowAddress)  main.holdingRegsLowAddress  = address;
                        if (address > main.holdingRegsHighAddress) main.holdingRegsHighAddress = address;
                    }
                }
                if (main.ac.holdingRegs.length) {
                    main.holdingRegsLength = main.holdingRegsHighAddress - main.holdingRegsLowAddress + 1;
                } else {
                    main.holdingRegsLength = 0;
                }
                for (i = 0; i <  main.ac.holdingRegs.length; i++) {
                    main.holdingRegsMapping[main.ac.holdingRegs[i].address - main.holdingRegsLowAddress] = adapter.namespace + '.' + main.ac.holdingRegs[i].id;
                }
            }

            // ------------------ create devices -------------
            if (main.ac.disInputs.length > 0) {
                adapter.setObject('discreteInputs', {
                    type: 'channel',
                    common: {
                        name: 'Discrete inputs'
                    },
                    native: {}
                });
            }

            if (main.ac.coils.length > 0) {
                adapter.setObject('coils', {
                    type: 'channel',
                    common: {
                        name: 'Coils'
                    },
                    native: {}
                });
            }

            if (main.ac.inputRegs.length > 0) {
                adapter.setObject('inputRegisters', {
                    type: 'channel',
                    common: {
                        name: 'Input registers'
                    },
                    native: {}
                });
            }

            if (main.ac.holdingRegs.length > 0) {
                adapter.setObject('holdingRegisters', {
                    type: 'channel',
                    common: {
                        name: 'Holding registers'
                    },
                    native: {}
                });
            }

            // ------------- create states and objects ----------------------------
            for (i = 0; main.ac.disInputs.length > i; i++) {
                if (main.oldObjects[adapter.namespace + '.' + main.ac.disInputs[i].id]) {
                    main.history = main.oldObjects[adapter.namespace + '.' + main.ac.disInputs[i].id].common.history || {
                            enabled:     false,
                            changesOnly: true,
                            minLength:   480,
                            maxLength:   960,
                            retention:   604800,
                            debounce:    10000
                        };
                } else {
                    main.history = {
                        enabled:      false,
                        changesOnly:  true,
                        minLength:    480,
                        maxLength:    960,
                        retention:    604800,
                        debounc:      10000
                    };
                }

                adapter.setObject(main.ac.disInputs[i].id, {
                    type: 'state',
                    common: {
                        name:    main.ac.disInputs[i].description,
                        role:    main.ac.disInputs[i].role,
                        type:    'boolean',
                        read:    true,
                        write:   false,
                        def:     false,
                        history: main.history
                    },
                    native: {
                        type:     'disInputs',
                        address:   main.ac.disInputs[i].address
                    }
                });

                syncEnums('rooms', adapter.namespace + '.' + main.ac.disInputs[i].id, main.ac.disInputs[i].room);

                main.newObjects.push(adapter.namespace + '.' + main.ac.disInputs[i].id);
            }

            for (i = 0; main.ac.coils.length > i; i++) {
                if (main.oldObjects[adapter.namespace + '.' + main.ac.coils[i].id]) {
                    main.history = main.oldObjects[adapter.namespace + '.' + main.ac.coils[i].id].common.history || {
                            "enabled":     false,
                            "changesOnly": true,
                            "minLength":   480,
                            "maxLength":   960,
                            "retention":   604800,
                            "debounce":    10000
                        };
                } else {
                    main.history = {
                        "enabled":     false,
                        "changesOnly": true,
                        "minLength":   480,
                        "maxLength":   960,
                        "retention":   604800,
                        "debounce":    10000
                    };
                }
                adapter.setObject(main.ac.coils[i].id, {
                    type: 'state',
                    common: {
                        name:    main.ac.coils[i].description,
                        role:    main.ac.coils[i].role,
                        type:    'boolean',
                        read:    true,
                        write:   true,
                        def:     false,
                        history: main.history
                    },
                    native: {
                        type:      'coils',
                        address:   main.ac.coils[i].address,
                        poll:      main.ac.coils[i].poll,
                        wp:        main.ac.coils[i].wp
                    }
                });
                syncEnums('rooms', adapter.namespace + '.' + main.ac.coils[i].id, main.ac.coils[i].room);
                main.newObjects.push(adapter.namespace + '.' + main.ac.coils[i].id);
            }

            for (i = 0; main.ac.inputRegs.length > i; i++) {
                if (main.oldObjects[adapter.namespace + '.' + main.ac.inputRegs[i].id]) {
                    main.history = main.oldObjects[adapter.namespace + '.' + main.ac.inputRegs[i].id].common.history || {
                            enabled:     false,
                            changesOnly: true,
                            minLength:   480,
                            maxLength:   960,
                            retention:   604800,
                            debounce:    10000
                        };
                } else {
                    main.history = {
                        enabled:     false,
                        changesOnly: true,
                        minLength:   480,
                        maxLength:   960,
                        retention:   604800,
                        debounce:    10000
                    };
                }
                adapter.setObject(main.ac.inputRegs[i].id, {
                    type: 'state',
                    common: {
                        name:    main.ac.inputRegs[i].description,
                        type:    'number',
                        read:    true,
                        write:   false,
                        def:     0,
                        role:    main.ac.inputRegs[i].role,
                        unit:    main.ac.inputRegs[i].unit || '',
                        history: main.history
                    },
                    native: {
                        type:     'inputRegs',
                        address:   main.ac.inputRegs[i].address
                    }
                });

                syncEnums('rooms', adapter.namespace + '.' + main.ac.inputRegs[i].id, main.ac.inputRegs[i].room);

                main.newObjects.push(adapter.namespace + '.' + main.ac.inputRegs[i].id);
            }

            for (i = 0; main.ac.holdingRegs.length > i; i++) {
                if (main.oldObjects[adapter.namespace + '.' + main.ac.holdingRegs[i].id]) {
                    main.history = main.oldObjects[adapter.namespace + '.' + main.ac.holdingRegs[i].id].common.history || {
                        enabled:     false,
                        changesOnly: true,
                        minLength:   480,
                        maxLength:   960,
                        retention:   604800,
                        debounce:    10000
                    };
                } else {
                    main.history = {
                        enabled:     false,
                        changesOnly: true,
                        minLength:   480,
                        maxLength:   960,
                        retention:   604800,
                        debounce:    10000
                    };
                }
                adapter.setObject(main.ac.holdingRegs[i].id, {
                    type: 'state',
                    common: {
                        name:    main.ac.holdingRegs[i].description,
                        type:    'number',
                        read:    true,
                        write:   true,
                        def:     0,
                        role:    main.ac.holdingRegs[i].role,
                        unit:    main.ac.holdingRegs[i].unit || '',
                        history: main.history
                    },
                    native: {
                        type:     'holdingRegs',
                        address:   main.ac.holdingRegs[i].address,
                        poll:      main.ac.holdingRegs[i].poll/*,
                        wp:        main.ac.coils[i].wp*/
                    }
                });

                syncEnums('rooms', adapter.namespace + '.' + main.ac.holdingRegs[i].id, main.ac.holdingRegs[i].room);

                main.newObjects.push(adapter.namespace + '.' + main.ac.holdingRegs[i].id);
            }

            // ----------- remember poll values --------------------------
            if (!main.acp.slave) {
                for (i = 0; main.ac.disInputs.length > i; i++) {
                    main.disInputs.push(main.ac.disInputs[i]);
                }

                for (i = 0; main.ac.coils.length > i; i++) {
                    if (main.ac.coils[i].poll) {
                        main.coils.push(main.ac.coils[i]);
                    }
                }

                for (i = 0; main.ac.inputRegs.length > i; i++) {
                    main.inputRegs.push(main.ac.inputRegs[i]);
                }

                for (i = 0; main.ac.holdingRegs.length > i; i++) {
                    if (main.ac.holdingRegs[i].poll) {
                        main.holdingRegs.push(main.ac.holdingRegs[i]);
                    }
                }
            } else {
                // read all states
                adapter.getStates('*', function (err, states) {
                    var id;
                    // build ready arrays
                    for (i = 0; main.ac.disInputs.length > i; i++) {
                        id = adapter.namespace + '.' + main.ac.disInputs[i].id;
                        if (states[id]) {
                            if (states[id].val === 'true')  states[id].val = 1;
                            if (states[id].val === '1')     states[id].val = 1;
                            if (states[id].val === '0')     states[id].val = 0;
                            if (states[id].val === 'false') states[id].val = false;
                            states[id].val = !!states[id].val;
                            main.disInputs[main.ac.disInputs[i].address - main.disInputsLowAddress] = states[id].val;
                        } else {
                            adapter.setState(id, 0, true);
                        }
                    }
                    // fill with 0 empty values
                    for (i = 0; i < main.disInputs.length; i++) {
                        if (main.disInputs[i] === undefined || main.disInputs[i] === null) {
                            main.disInputs[i] = 0;
                        } else if (typeof main.disInputs[i] === 'boolean') {
                            main.disInputs[i] = main.disInputs[i] ? 1 : 0;
                        } else if (typeof main.disInputs[i] !== 'number') {
                            main.disInputs[i] = parseInt(main.disInputs[i], 10) ? 1 : 0;
                        }
                    }

                    for (i = 0; main.ac.coils.length > i; i++) {
                        id = adapter.namespace + '.' + main.ac.coils[i].id;
                        if (states[id]) {
                            if (states[id].val === 'true')  states[id].val = 1;
                            if (states[id].val === '1')     states[id].val = 1;
                            if (states[id].val === '0')     states[id].val = 0;
                            if (states[id].val === 'false') states[id].val = false;
                            states[id].val = !!states[id].val;
                            main.coils[main.ac.coils[i].address - main.coilsLowAddress] = states[id].val;
                        } else {
                            adapter.setState(id, 0, true);
                        }
                    }
                    // fill with 0 empty values
                    for (i = 0; i < main.coils.length; i++) {
                        if (main.coils[i] === undefined || main.coils[i] === null) {
                            main.coils[i] = 0;
                        } else if (typeof main.coils[i] === 'boolean') {
                            main.coils[i] = main.coils[i] ? 1 : 0;
                        } else if (typeof main.coils[i] !== 'number') {
                            main.coils[i] = parseInt(main.coils[i], 10) ? 1 : 0;
                        }
                    }

                    for (i = 0; main.ac.inputRegs.length > i; i++) {
                        id = adapter.namespace + '.' + main.ac.inputRegs[i].id;
                        if (states[id]) {
                            if (states[id].val === 'true'  || states[id].val === true)  states[id].val = 1;
                            if (states[id].val === 'false' || states[id].val === false) states[id].val = 0;
                            states[id].val = parseInt(states[id].val, 10) || 0;
                            main.inputRegs[main.ac.inputRegs[i].address - main.inputRegsLowAddress] = states[id].val;
                        } else {
                            adapter.setState(id, 0, true);
                        }
                    }
                    // fill with 0 empty values
                    for (i = 0; i < main.inputRegs.length; i++) {
                        if (main.inputRegs[i] === undefined || main.inputRegs[i] === null) {
                            main.inputRegs[i] = 0;
                        } else if (typeof main.inputRegs[i] === 'boolean') {
                            main.inputRegs[i] = main.inputRegs[i] ? 1 : 0;
                        } else if (typeof main.inputRegs[i] !== 'number') {
                            main.inputRegs[i] = parseInt(main.inputRegs[i], 10);
                        }
                    }

                    for (i = 0; main.ac.holdingRegs.length > i; i++) {
                        id = adapter.namespace + '.' + main.ac.holdingRegs[i].id;
                        if (states[id]) {
                            if (states[id].val === 'true')  states[id].val = 1;
                            if (states[id].val === 'false') states[id].val = 0;
                            states[id].val = parseInt(states[id].val, 10) || 0;
                            main.holdingRegs[main.ac.holdingRegs[i].address - main.holdingRegsLowAddress] = states[id].val;
                        } else {
                            adapter.setState(id, 0, true);
                        }
                    }
                    // fill with 0 empty values
                    for (i = 0; i < main.holdingRegs.length; i++) {
                        if (main.holdingRegs[i] === undefined || main.holdingRegs[i] === null) {
                            main.holdingRegs[i] = 0;
                        } else if (typeof main.holdingRegs[i] === 'boolean') {
                            main.holdingRegs[i] = main.holdingRegs[i] ? 1 : 0;
                        } else if (typeof main.holdingRegs[i] !== 'number') {
                            main.holdingRegs[i] = parseInt(main.holdingRegs[i], 10);
                        }
                    }
                });
            }

            adapter.setObject("info", {
                type: 'channel',
                common: {
                    name:    "info"
                },
                native: {}
            });

            if (!main.acp.slave) {
                adapter.setObject('info.pollTime', {
                    type: 'state',
                    common: {
                        name: "Poll time",
                        type: 'number',
                        role: '',
                        write: false,
                        read:  true,
                        def:   0,
                        unit: 'ms'
                    },
                    native: {}
                });
                main.newObjects.push(adapter.namespace + ".info.pollTime");
            }

            adapter.setObject('info.connection', {
                type: 'state',
                common: {
                    name:  'Number of connected partners',
                    role:  'indicator.connection',
                    write: false,
                    read:  true,
                    def:   0,
                    type:  'number'
                },
                native: {}
            });
            main.newObjects.push(adapter.namespace + '.info.connection');

            adapter.setState('info.connection', 0, true);

            // clear unused states
            var l = main.oldObjects.length;

            function clear() {
                for (var id in main.oldObjects) {
                    if (main.newObjects.indexOf(id) == -1) {
                        adapter.delObject(id, function () {

                        });
                    }
                }

                main.oldObjects = [];
                main.newObjects = [];
                adapter.subscribeStates('*');
                main.start();
            }

            clear();
        });
    },

    start: function () {

        if (main.acp.slave) {
            var handlers = {};

            // read all states first time
            var Server = require('modbus-stack/server');

            // override on connect
            Server.prototype._setupConn = function (socket) {
                var self = this;
                var response = new modbus.ModbusResponseStack(socket);
                response.on('request', function (request) {
                    self.emit('request', request, response);
                    if (socket.readable && socket.writable) {
                        self._setupConn(socket);
                    }
                }).on('error', function (err) {
                    self.emit('error', err);
                });
            };
            
            Server.RESPONSES[modbus.FUNCTION_CODES.READ_HOLDING_REGISTERS] = function (registers) {
                var put = new Put().word8(registers.length * 2);

                for (var i = 0, l = registers.length; i < l; i++) {
                    put.word16be(registers[i]);
                }
                return put.buffer();
            };
            Server.RESPONSES[modbus.FUNCTION_CODES.READ_INPUT_REGISTERS] = Server.RESPONSES[modbus.FUNCTION_CODES.READ_HOLDING_REGISTERS];
            Server.RESPONSES[modbus.FUNCTION_CODES.READ_DISCRETE_INPUTS] = function (registers) {
                var put = new Put().word8(registers.length);

                for (var i = 0, l = registers.length; i < l; i+=2) {
                    put.word16be((registers[i] << 8) + registers[i + 1]);
                }
                return put.buffer();
            };
            Server.RESPONSES[modbus.FUNCTION_CODES.READ_COILS] = Server.RESPONSES[modbus.FUNCTION_CODES.READ_DISCRETE_INPUTS];
            Server.RESPONSES[modbus.FUNCTION_CODES.WRITE_SINGLE_COIL] = function (registers) {
                var put = new Put().word16be(registers.address);
                put.word16be(registers.value ? 0xFF00 : 0);
                return put.buffer();
            };
            Server.RESPONSES[modbus.FUNCTION_CODES.WRITE_SINGLE_REGISTER] = function (registers) {
                var put = new Put().word16be(registers.address);
                put.word16be(registers.value);
                return put.buffer();
            };

            handlers[modbus.FUNCTION_CODES.READ_DISCRETE_INPUTS] = function (request, response) {
                var start  = request.startAddress;
                var length = request.quantity;

                var resp = new Array(Math.ceil(length / 16) * 2);

                var i = 0;
                for (var j = 0; j < resp.length; j++) {
                    resp[j] = 0;
                }
                while (i < length && i + start <= main.disInputsHighAddress) {
                    if (main.disInputs[i + start - main.disInputsLowAddress]) {
                        resp[Math.floor(i / 8)] |= 1 << (i % 8);
                    }
                    i++;
                }


                response.writeResponse(resp);
            };
            handlers[modbus.FUNCTION_CODES.READ_COILS] = function (request, response) {
                var start  = request.startAddress;
                var length = request.quantity;

                //console.log(new Date() + 'READ_COILS [' +  start + ']: ' + length);
                var resp = new Array(Math.ceil(length / 16) * 2);
                var i = 0;
                for (var j = 0; j < resp.length; j++) {
                    resp[j] = 0;
                }
                while (i < length && i + start <= main.coilsHighAddress) {
                    if (main.coils[i + start - main.coilsLowAddress]) {
                        resp[Math.floor(i / 8)] |= 1 << (i % 8);
                    }
                    i++;
                }

                response.writeResponse(resp);
            };
            handlers[modbus.FUNCTION_CODES.READ_HOLDING_REGISTERS] = function (request, response) {
                var start  = request.startAddress;
                var length = request.quantity;

                var resp = new Array(length);
                var i = 0;
                while (i < length && i + start < main.holdingRegsLowAddress) {
                    resp[i] = 0;
                    i++;
                }
                while (i < length && i + start <= main.holdingRegsHighAddress) {
                    resp[i] = main.holdingRegs[i + start - main.holdingRegsLowAddress];
                    i++;
                }
                if (i > main.holdingRegsHighAddress) {
                    while (i < length) {
                        resp[i] = 0;
                        i++;
                    }
                }

                response.writeResponse(resp);
            };
            handlers[modbus.FUNCTION_CODES.READ_INPUT_REGISTERS] = function (request, response) {
                var start  = request.startAddress;
                var length = request.quantity;

                var resp = new Array(length);
                var i = 0;
                while (i < length && i + start < main.inputRegsLowAddress) {
                    resp[i] = 0;
                    i++;
                }
                while (i < length && i + start <= main.inputRegsHighAddress) {
                    resp[i] = main.inputRegs[i + start - main.inputRegsLowAddress];
                    i++;
                }
                if (i > main.inputRegsHighAddress) {
                    while (i < length) {
                        resp[i] = 0;
                        i++;
                    }
                }

                response.writeResponse(resp);
            };
            handlers[modbus.FUNCTION_CODES.WRITE_SINGLE_COIL] = function (request, response) {
                var a = request.address - main.coilsLowAddress;
                adapter.log.debug('WRITE_SINGLE_COIL [' + (main.coilsMapping[a] ? main.coilsMapping[a] : request.address) + ']: ' + request.value);
                if (main.coilsMapping[a]) {
                    adapter.setState(main.coilsMapping[a], request.value, true);
                    main.coils[a] = request.value;
                }

                response.writeResponse(response);
            };
            handlers[modbus.FUNCTION_CODES.WRITE_SINGLE_REGISTER] = function (request, response) {
                var a = request.address - main.holdingRegsLowAddress;
                adapter.log.debug('WRITE_SINGLE_REGISTER [' +  (main.holdingRegsMapping[a] ? main.holdingRegsMapping[a] : request.address) + ']: ' + request.value);
                if (main.holdingRegsMapping[a]) {
                    adapter.setState(main.holdingRegsMapping[a], request.value, true);
                    main.holdingRegs[a] = request.value;
                }

                response.writeResponse(request);
            };
            /*handlers[modbus.FUNCTION_CODES.WRITE_MULTIPLE_COILS] = function (request, response) {
                var start  = request.startAddress;
                var length = request.quantity;

                var i = 0;
                while (i < length && i + start <= main.coilsLowAddress) {
                    var a = (i + start - main.coilsLowAddress);
                    if (main.coilsMapping[a]) {
                        adapter.setState(main.coilsMapping[a], request[i].value, true);
                        main.coils[a] = request[i].value;
                    }
                    i++;
                }

                response.writeResponse(request);
            };
            handlers[modbus.FUNCTION_CODES.WRITE_MULTIPLE_REGISTERS] = function (request, response) {
                var start  = request.startAddress;
                var length = request.quantity;

                var i = 0;
                while (i < length && i + start <= main.holdingRegsLowAddress) {
                    var a = i + start - main.holdingRegsLowAddress;
                    if (main.holdingRegsMapping[a]) {
                        adapter.setState(main.holdingRegsMapping[a], request[i].value, true);
                        main.holdingRegs[a] = request[i].value;
                    }
                    i++;
                }

                response.writeResponse(request);
            };*/

            modbusServer = Server.createServer(handlers).listen(main.acp.port);
            modbusServer.on('connection', function (client) {
                connected++;
                adapter.log.info('Clients connected: ' + modbusServer._connections);
                adapter.setState('info.connection', modbusServer._connections, true);
            }).on('close', function (client) {
                adapter.setState('info.connection', modbusServer._connections, true);
            }).on('error', function (err) {
                adapter.log.info('Clients connected: ' + modbusServer._connections);
                adapter.setState('info.connection', modbusServer._connections, true);
                adapter.log.warn(err);
            });

        } else {
            var Client = require('modbus-stack/client');
            Client.RESPONSES[modbus.FUNCTION_CODES.READ_DISCRETE_INPUTS] = function (bufferlist) {
                var rtn = [];
                var binary = new Binary(bufferlist).getWord8('byteLength').end();
                rtn.byteLength = binary.vars.byteLength;
                var i;
                var l;
                var val;
                var val1;
                var b;
                for (i = 0, l = Math.floor(binary.vars.byteLength / 2); i < l; i++) {
                    binary.getWord16be('val');
                    val = binary.end().vars.val;
                    val1 = val & 0xFF;
                    for (b = 0; b < 8; b++) {
                        rtn[i * 16 + (7 - b)] = (((val1 >> b) & 1) ? true : false);
                    }
                    val1 = val >> 8;
                    for (b = 0; b < 7; b++) {
                        rtn[i * 16 + 15 - b] = (((val1 >> b) & 1) ? true : false);
                    }
                }
                // read last byte
                if (i * 2 < binary.vars.byteLength) {
                    binary.getWord8('val');
                    val = binary.end().vars.val;
                    for (b = 0; b < 8; b++) {
                        rtn[i * 16 + (7 - b)] = (((val1 >> b) & 1) ? true : false);
                    }
                }
                return rtn;
            };
            Client.RESPONSES[modbus.FUNCTION_CODES.READ_COILS] = Client.RESPONSES[modbus.FUNCTION_CODES.READ_DISCRETE_INPUTS];
            Client.RESPONSES[modbus.FUNCTION_CODES.READ_INPUT_REGISTERS] = function (bufferlist) {
                var rtn = [];
                var binary = new Binary(bufferlist).getWord8('byteLength').end();
                rtn.byteLength = binary.vars.byteLength;
                for (var i = 0, l = binary.vars.byteLength / 2; i < l; i++) {
                    binary.getWord16be('val');
                    rtn.push(binary.end().vars.val);
                }
                return rtn;
            };
            Client.RESPONSES[modbus.FUNCTION_CODES.READ_HOLDING_REGISTERS] = Client.RESPONSES[modbus.FUNCTION_CODES.READ_INPUT_REGISTERS];
            Client.RESPONSES[modbus.FUNCTION_CODES.WRITE_SINGLE_REGISTER] = Client.RESPONSES[modbus.FUNCTION_CODES.READ_INPUT_REGISTERS];
            Client.RESPONSES[modbus.FUNCTION_CODES.WRITE_SINGLE_COIL] = Client.RESPONSES[modbus.FUNCTION_CODES.READ_DISCRETE_INPUTS];
            Client.REQUESTS[modbus.FUNCTION_CODES.WRITE_SINGLE_REGISTER] = function (address, value) {
                return new Put()
                    .word16be(address)
                    .word16be(value)
                    .buffer();
            };

            modbusClient = Client.createClient(main.acp.port, main.acp.bind);

            modbusClient.on('connect', function () {
                if (!connected) {
                    adapter.log.info('Connected to slave ' + main.acp.bind);
                    connected = 1;
                    adapter.setState('info.connection', 1, true);
                }
                main.poll();
            }).on('disconnect', function () {
                if (connected) {
                    adapter.log.info('Disconnected from slave ' + main.acp.bind);
                    connected = 0;
                    adapter.setState('info.connection', 0, true);
                }
                setTimeout(function () {
                    main.start();
                }, main.acp.recon);
            });

            modbusClient.on('error', function (err) {
                adapter.log.warn(err);
                if (connected) {
                    adapter.log.info('Disconnected from slave ' + main.acp.bind);
                    connected = 0;
                    adapter.setState('info.connection', 0, true);
                }
                setTimeout(function () {
                    main.start();
                }, main.acp.recon);
            });
        }
    },

    pollDisInputs: function (callback) {
        if (main.disInputsLength) {
            modbusClient.request(modbus.FUNCTION_CODES.READ_DISCRETE_INPUTS, main.disInputsLowAddress, main.disInputsLength, function (err, registers) {
                if (err) {
                    callback(err);
                } else {
                    for (var n = 0; main.disInputs.length > n; n++) {
                        var id = main.disInputs[n].id;
                        var val = registers[main.disInputs[n].address - main.disInputsLowAddress];

                        if (ackObjects[id] === undefined || ackObjects[id].val !== val) {
                            ackObjects[id] = {val: val};
                            adapter.setState(id, val ? true : false, true);
                        }
                    }
                    callback(null);
                }
            });
        } else {
            callback(null);
        }
    },
    pollCoils: function (callback) {
        if (main.coilsLength) {
            modbusClient.request(modbus.FUNCTION_CODES.READ_COILS, main.coilsLowAddress, main.coilsLength, function (err, registers) {
                if (err) {
                    if (!cbCalled.coils) callback(err);
                } else {
                    for (var n = 0; main.coils.length > n; n++) {
                        var id = main.coils[n].id;
                        var val = registers[main.coils[n].address - main.coilsLowAddress];

                        if (ackObjects[id] === undefined || ackObjects[id].val !== val) {
                            ackObjects[id] = {val: val};
                            adapter.setState(id, val ? true : false, true);
                        }
                    }
                    callback(null);
                }
            });
        } else {
            callback(null);
        }
    },
    pollInputRegs: function (callback) {
        if (main.inputRegsLength) {
            modbusClient.request(modbus.FUNCTION_CODES.READ_INPUT_REGISTERS, main.inputRegsLowAddress, main.inputRegsLength, function (err, registers) {
                if (err) {
                    callback(err);
                } else {
                    for (var n = 0; main.inputRegs.length > n; n++) {
                        var id = main.inputRegs[n].id;
                        var val = registers[main.inputRegs[n].address - main.inputRegsLowAddress];

                        if (ackObjects[id] === undefined || ackObjects[id].val !== val) {
                            ackObjects[id] = {val: val};
                            adapter.setState(id, val, true);
                        }
                    }
                    callback(null);
                }
            });
        } else {
            callback(null);
        }
    },
    pollHoldingRegs: function (callback) {
        if (main.holdingRegsLength) {
            modbusClient.request(modbus.FUNCTION_CODES.READ_HOLDING_REGISTERS, main.holdingRegsLowAddress, main.holdingRegsLength, function (err, registers) {
                if (err) {
                    callback(err);
                } else {
                    for (var n = 0; main.holdingRegs.length > n; n++) {
                        var id = main.holdingRegs[n].id;
                        var val = registers[main.holdingRegs[n].address - main.holdingRegsLowAddress];

                        if (ackObjects[id] === undefined || ackObjects[id].val !== val) {
                            ackObjects[id] = {val: val};
                            adapter.setState(id, val, true);
                        }
                    }
                    callback(null);
                }
            });
        } else {
            callback(null);
        }
    },

    pollResult: function (startTime, err) {
        if (err) {
            main.errorCount++;

            adapter.log.warn('Poll error count: ' + main.errorCount + ' code: ' + err);
            adapter.setState('info.connection', 0, true);

            if (main.errorCount < 6 && connected) {
                setTimeout(main.poll, main.acp.poll);
            } else {
                if (connected) {
                    adapter.log.info('Disconnected from slave ' + main.acp.bind);
                    connected = 0;
                    adapter.setState('info.connection', 0, true);
                }
                adapter.log.error('try reconnection');
                setTimeout(function () {
                    main.start();
                }, main.acp.recon);
            }
        } else {
            var currentPollTime = (new Date()).valueOf() - startTime;
            if (main.pollTime !== null && main.pollTime !== undefined) {
                if (Math.abs(main.pollTime - currentPollTime) > 100) {
                    main.pollTime = currentPollTime;
                    adapter.setState('info.pollTime', currentPollTime, true);
                }
            } else {
                main.pollTime = currentPollTime;
                adapter.setState('info.pollTime', currentPollTime, true);
            }

            if (main.errorCount > 0) {
                adapter.setState('info.connection', 1, true);
                main.errorCount = 0;
            }
            nextPoll = setTimeout(main.poll, main.acp.poll);
        }
    },

    poll: function () {
        var startTime = (new Date()).valueOf();

        main.pollDisInputs(function (err) {
            if (err) return main.pollResult(startTime, err);
            main.pollCoils(function (err) {
                if (err) return main.pollResult(startTime, err);
                main.pollInputRegs(function (err) {
                    if (err) return main.pollResult(startTime, err);
                    main.pollHoldingRegs(function (err) {
                        main.pollResult(startTime, err);
                    });
                });
            });
        });
    }
};

function sortByAddress(a, b) {
    var ad = parseFloat(a.address);
    var bd = parseFloat(b.address);
    return ((ad < bd) ? -1 : ((ad > bd) ? 1 : 0));
}
