// Copyright (C) 2011-2014 Massachusetts Institute of Technology
// Chris Terman

// keep jslint happy
//var console,JSON;
//var $,jade,cktsim,plot;

jade.test_view = (function() {

    //////////////////////////////////////////////////////////////////////
    //
    // Test editor
    //
    //////////////////////////////////////////////////////////////////////

    /* example test script:

     // set up Vdd, establish signaling voltages
     .power Vdd=1
     .thresholds Vol=0 Vil=0.1 Vih=0.9 Voh=1

     // test actions are applied to named groups of signals.
     // A signal can appear in more than one group.  Order
     // of groups and signals within each group determine 
     // order of values on each line of test values
     .group inputs A B
     .group outputs Z

     // tests are sequences of lines supplying test values; .cycle specifies
     // actions that will be performed for each test.  Available actions are
     //   assert <group> -- set values for signals in <group> with H,L test values
     //   deassert <group> -- stop setting values for signals in <group> with H,L test values
     //   sample <group> -- check values of signals in <group> with 0,1 test values
     //   tran <time> -- run transient simulation for specified time interval
     //   <signal>=<val> -- set signal to specified value
     .cycle assert inputs tran 9n sample outputs tran 1n

     // the tests themselves -- one test per line
     //   to assert signal this cycle use 0,1,Z
     //   to sample signal this cycle use L,H
     //   use - if signal shouldn't be asserted/sampled
     // whitespace can be used to improve readability
     00 L
     01 H
     10 H 
     11 L

     */

    jade.schematic_view.schematic_tools.push(['check',
                                              jade.icons.check_icon,
                                              'Check: run tests',
                                              do_test]);

    function do_test(diagram) {
        var module = diagram.aspect.module;
        if (module) {
            if (module.has_aspect('test')) {
                var test = module.aspect('test').components[0];
                if (test) {
                    run_tests(test.test,diagram,module);
                    return;
                }
            }
        }

        diagram.message('This module does not have a test!');
    }

    function TestEditor(div, parent) {
        this.jade = parent;
        this.status = parent.status;
        this.module = undefined;
        this.aspect = undefined;
        this.test_component = undefined;

        var textarea = $('<textarea class="jade-test-editor"></textarea>');
        this.textarea = textarea;
        // on changes, update test component of module's test aspect
        var editor = this;  // for closure
        textarea.on('mouseleave',function() {
            if (editor.test_component) {
                var text = textarea.val();
                if (editor.test_component.test != text) {
                    editor.test_component.test = text;
                    editor.aspect.set_modified(true);
                }
            }
        });
        div.appendChild(textarea[0]);
    }

    TestEditor.prototype.resize = function(w, h, selected) {
        var e = this.textarea;

        var w_extra = e.outerWidth(true) - e.width();
        var h_extra = e.outerHeight(true) - e.height();
        
        var tw = w -  w_extra;
        var th = h - h_extra;
        e.width(tw);
        e.height(th);
    };

    TestEditor.prototype.show = function() {};

    TestEditor.prototype.set_aspect = function(module) {
        this.module = module;
        this.aspect = module.aspect('test');
        this.test_component = this.aspect.components[0];
        if (this.test_component === undefined) {
            this.test_component = jade.model.make_component(["test",""]);
            this.aspect.add_component(this.test_component);
        }
        this.textarea.val(this.test_component.test);

        if (this.aspect.read_only()) this.textarea.attr('disabled','disabled');
        else this.textarea.removeAttr('disabled');
    };

    TestEditor.prototype.event_coords = function () { };

    TestEditor.prototype.check = function () {
        run_tests(this.textarea.val(),this,this.module);
    };

    TestEditor.prototype.message = function(msg) {
        this.status.text(msg);
    };

    TestEditor.prototype.clear_message = function(msg) {
        if (this.status.text() == msg)
            this.status.text('');
    };

    TestEditor.prototype.editor_name = 'test';
    jade.editors.push(TestEditor);

    // Test component that lives inside a Test aspect
    function Test(json) {
        jade.model.Component.call(this);
        this.load(json);
    }
    Test.prototype = new jade.model.Component();
    Test.prototype.constructor = Test;
    Test.prototype.type = function () { return 'test'; };
    jade.model.built_in_components.test = Test;

    Test.prototype.load = function(json) {
        this.test = json[1];
    };

    Test.prototype.json = function() {
        return [this.type(), this.test];
    };

    function run_tests(source,diagram,module) {
        var test_results = diagram.editor.jade.configuration.tests;
        test_results[module.get_name()] = 'Error detected: test did not yield a result.';
        var msg;

        // remove multiline comments, in-line comments
        source = source.replace(/\/\*(.|\n)*?\*\//g,'');   // multi-line using slash-star
        source = source.replace(/\/\/.*\n/g,'\n');

        var i,j,k,v;
        var mode = 'device';  // which simulation to run
        var plots = [];     // list of signals to plot
        var tests = [];     // list of test lines
        var power = {};     // node name -> voltage
        var thresholds = {};  // spec name -> voltage
        var cycle = [];    // list of test actions: [action args...]
        var groups = {};   // group name -> list of indicies
        var signals = [];  // list if signals in order that they'll appear on test line
        var driven_signals = {};   // if name in dictionary it will need a driver ckt
        var sampled_signals = {};   // if name in dictionary we want its value
        var errors = [];

        // process each line in test specification
        source = source.split('\n');
        for (k = 0; k < source.length; k += 1) {
            var line = source[k].match(/([A-Za-z0-9_.:\[\]]+|=|-)/g);
            if (line === null) continue;
            if (line[0] == '.mode') {
                if (line.length != 2) errors.push('Malformed .mode statement: '+source[k]);
                else if (line[1] == 'device' || line[1] == 'gate') mode = line[1]
                else errors.push('Unrecognized simulation mode: '+line[1]);
            }
            else if (line[0] == '.power' || line[0] == '.thresholds') {
                // .power/.thresholds name=float name=float ...
                for (i = 1; i < line.length; i += 3) {
                    if (i + 2 >= line.length || line[i+1] != '=') {
                        errors.push('Malformed '+line[0]+' statement: '+source[k]);
                        break;
                    }
                    v = jade.utils.parse_number(line[i+2]);
                    if (isNaN(v)) {
                        errors.push('Unrecognized voltage specification "'+line[i+2]+'": '+source[k]);
                        break;
                    }
                    if (line[0] == '.power') power[line[i]] = v;
                    else thresholds[line[i]] = v;
                }
            }
            else if (line[0] == '.group') {
                // .group group_name name...
                if (line.length < 3) {
                    errors.push('Malformed .group statement: '+source[k]);
                } else {
                    // each group has an associated list of signal indicies
                    groups[line[1]] = [];
                    for (j = 2; j < line.length; j += 1) {
                        $.each(jade.utils.parse_signal(line[j]),function (index,sig) {
                            // remember index of this signal in the signals list
                            groups[line[1]].push(signals.length);
                            // keep track of signal names
                            signals.push(sig);
                        });
                    }
                }
            }
            else if (line[0] == '.plot') {
                for (j = 1; j < line.length; j += 1) {
                    $.each(jade.utils.parse_signal(line[j]), function (index,sig) {
                        plots.push(sig);
                        sampled_signals[sig] = [];
                    });
                }
            }
            else if (line[0] == '.cycle') {
                // .cycle actions...
                //   assert <group_name>
                //   deassert <group_name>
                //   sample <group_name>
                //   tran <duration>
                //   <name> = <voltage>
                if (cycle.length != 0) {
                    errors.push('More than one .cycle statement: '+source[k]);
                    break;
                }
                i = 1;
                while (i < line.length) {
                    if ((line[i] == 'assert' || line[i] == 'deassert' || line[i] == 'sample') && i + 1 < line.length) {
                        var glist = groups[line[i+1]];
                        if (glist === undefined) {
                            errors.push('Use of undeclared group name "'+line[i+1]+'" in .cycle: '+source[k]);
                            break;
                        }
                        // keep track of which signals are driven and sampled
                        for (j = 0; j < glist.length; j += 1) {
                            if (line[i] == 'assert' || line[i] == 'deassert')
                                driven_signals[signals[glist[j]]] = [[0,'Z']]; // driven node is 0 at t=0
                            if (line[i] == 'sample')
                                sampled_signals[signals[glist[j]]] = []; // list of tvpairs
                        }
                        cycle.push([line[i],line[i+1]]);
                        i += 2;
                        continue;
                    }
                    else if (line[i] == 'tran' && (i + 1 < line.length)) {
                        v = jade.utils.parse_number(line[i+1]);
                        if (isNaN(v)) {
                            errors.push('Unrecognized tran duration "'+line[i+1]+'": '+source[k]);
                            break;
                        }
                        cycle.push(['tran',v]);
                        i += 2;
                        continue;
                    }
                    else if (line[i+1] == '=' && (i + 2 < line.length)) {
                        v = line[i+2];   // expect 0,1,Z
                        if ("01Z".indexOf(v) == -1) {
                            errors.push('Unrecognized value specification "'+line[i+2]+'": '+source[k]);
                            break;
                        }
                        cycle.push(['set',line[i],v]);
                        driven_signals[line[i]] = [[0,'Z']];  // driven node is 0 at t=0
                        i += 3;
                        continue;
                    }
                    errors.push('Malformed .cycle action "'+line[i]+'": '+source[k]);
                    break;
                }
            }
            else if (line[0][0] == '.') {
                errors.push('Unrecognized control statment: '+source[k]);
            }
            else {
                var test = line.join('');
                // each test should specify values for each signal in each group
                if (test.length != signals.length) {
                    errors.push('Test line does not specify '+signals.length+' signals: '+source[k]);
                    break;
                }
                // check for legal test values
                for (j = 0; j < test.length; j += 1) {
                    if ("01ZLH-".indexOf(test[j]) == -1) {
                        errors.push('Illegal test value '+test[j]+': '+source[k]);
                        break;
                    }
                }
                tests.push(test);
            }
        };

        // check for necessary threshold specs
        if (!('Vol' in thresholds)) errors.push('Missing Vol threshold specification');
        if (!('Vil' in thresholds)) errors.push('Missing Vil threshold specification');
        if (!('Vih' in thresholds)) errors.push('Missing Vih threshold specification');
        if (!('Voh' in thresholds)) errors.push('Missing Voh threshold specification');

        if (cycle.length == 0) errors.push('Missing .cycle specification');
        if (tests.length == 0) errors.push('No tests specified!');

        if (errors.length != 0) {
            msg = '<li>'+errors.join('<li>');
            diagram.message('The following errors were found in the test specification:'+msg);
            test_results[module.get_name()] = 'Error detected: invalid test specification'+msg;
            return;
        }

        //console.log('power: '+JSON.stringify(power));
        //console.log('thresholds: '+JSON.stringify(thresholds));
        //console.log('groups: '+JSON.stringify(groups));
        //console.log('cycle: '+JSON.stringify(cycle));
        //console.log('tests: '+JSON.stringify(tests));

        // extract netlist and make sure it has the signals referenced by the test
        if (!module.has_aspect('schematic')) {
            diagram.message('This module does not have a schematic!');
            test_results[module.get_name()] = 'Error detected: this module has no schematic!';
            return;
        }

        var netlist;
        try {
            if (mode == 'device')
                netlist = jade.device_level.device_netlist(module.aspect('schematic'));
            else if (mode == 'gate')
                netlist = jade.gate_level.gate_netlist(module.aspect('schematic'));
            else
                throw 'Unrecognized simulation mode: '+mode;
        }
        catch (e) {
            diagram.message("Error extracting netlist:<p>" + e);
            test_results[module.get_name()] = 'Error detected extracting netlist:<p>'+e;
            return;
        }

        var nodes = jade.netlist.extract_nodes(netlist);  // get list of nodes in netlist
        function check_node(node) {
            if (nodes.indexOf(node) == -1)
                errors.push('Circuit does not have a node named "'+node+'".');
        }
        $.each(driven_signals,check_node);
        $.each(sampled_signals,check_node);

        if (errors.length != 0) {
            msg = '<li>'+errors.join('<li>');
            diagram.message('The following errors were found in the test specification:'+msg);
            test_results[module.get_name()] = 'Error detected:'+msg;
            return;
        }

        // ensure simulator knows what gnd is
        netlist.push({type: 'ground',connections:['gnd'],properties:{}});

        // add voltage sources for power supplies
        $.each(power,function(node,v) {
            netlist.push({type:'voltage source',
                          connections:{nplus:node, nminus:'gnd'},
                          properties:{value:{type:'dc', args:[v]}, name:node+'_source'}});
        });

        // go through each test determining transition times for each driven node, adding
        // [t,v] pairs to driven_nodes dict.  v = '0','1','Z'
        var time = 0;
        function set_voltage(tvlist,v) {
            if (v != tvlist[tvlist.length - 1][1]) tvlist.push([time,v]);
        }
        $.each(tests,function(tindex,test) {
            $.each(cycle,function(index,action) {
                if (action[0] == 'assert' || action[0] == 'deassert') {
                    $.each(groups[action[1]],function(index,sindex) {
                        if (action[0] == 'deassert' || "01Z".indexOf(test[sindex]) != -1)
                            set_voltage(driven_signals[signals[sindex]],
                                        action[0] == 'deassert' ? 'Z' : test[sindex]);
                    });
                }
                else if (action[0] == 'sample') {
                    $.each(groups[action[1]],function(index,sindex) {
                        if ("HL".indexOf(test[sindex]) != -1)
                            sampled_signals[signals[sindex]].push([time,test[sindex]]);
                    });
                }
                else if (action[0] == 'set') {
                    set_voltage(driven_signals[action[1]],action[2]);
                }
                else if (action[0] == 'tran') {
                    time += action[1];
                }
            });
        });

        if (mode == 'device')
            build_inputs_device(netlist,driven_signals,thresholds);
        else if (mode == 'gate')
            build_inputs_gate(netlist,driven_signals,thresholds);
        else throw 'Unrecognized simulation mode: '+mode;
        //console.log('stop time: '+time);
        jade.netlist.print_netlist(netlist);

        // handle results fromt the simulation
        function process_results(percent_complete,results) {
            if (percent_complete === undefined) {
                jade.window_close(progress[0].win);  // done with progress bar

                if (typeof results == 'string') {
                    // oops, some sort of exception: just report it
                    diagram.message(results);
                    test_results[module.get_name()] = 'Error detected: '+results;
                    return undefined;
                } else if (results instanceof Error) {
                    diagram.message(results.stack.split('\n').join('<br>'));
                    test_results[module.get_name()] = 'Error detected: '+results.message;
                    return undefined;
                }

                // check the sampled node values for each test cycle
                var errors = [];
                $.each(sampled_signals,function(node,tvlist) {
                    var history = results._network_.history(node);
                    var times = history.xvalues;
                    var observed = history.yvalues;
                    $.each(tvlist,function(index,tvpair) {
                        var v;
                        if (mode == 'device') {
                            v = jade.device_level.interpolate(tvpair[0], times, observed);
                            if ((tvpair[1] == 'L' && v > thresholds.Vil) ||
                                (tvpair[1] == 'H' && v < thresholds.Vih)) 
                                errors.push('Expected signal '+node+' to be a valid '+tvpair[1]+
                                            ' at time '+jade.utils.engineering_notation(tvpair[0],2)+'s.');
                        }
                        else if (mode == 'gate') {
                            v = jade.gate_level.interpolate(tvpair[0], times, observed);
                            if ((tvpair[1] == 'L' && v != 0) ||
                                (tvpair[1] == 'H' && v != 1)) 
                                errors.push('Expected signal '+node+' to be a valid '+tvpair[1]+
                                            ' at time '+jade.utils.engineering_notation(tvpair[0],2)+'s.');
                        }
                        else throw 'Unrecognized simulation mode: '+mode;
                    });
                });

                if (errors.length > 0) {
                    var postscript = '';
                    if (errors.length > 3) {
                        errors = errors.slice(0,5);
                        postscript = '<br>...';
                    }
                    msg = '<ul><li>'+errors.join('<li>')+postscript+'</ul>';
                    diagram.message(msg);
                    test_results[module.get_name()] = 'Error detected: '+msg;
                } else {
                    diagram.message('Test succesful!');
                    test_results[module.get_name()] = 'passed';
                }

                // construct a data set for the given signal
                function new_dataset(signal) {
                    var history = results._network_.history(signal);
                    if (history !== undefined) {
                        return {xvalues: [history.xvalues],
                                yvalues: [history.yvalues],
                                name: [signal],
                                xunits: 's',
                                yunits: mode == 'device' ? 'V' : '',
                                color: ['#268bd2'],
                                type: [results._network_.result_type()]
                               };
                    } else return undefined;
                }

                // called by plot.graph when user wants to plot another signal
                function add_plot(signal) {
                    // construct data set for requested signal
                    // if the signal was legit, use callback to plot it
                    var dataset = new_dataset(signal);
                    if (dataset !== undefined) dataseries.push(dataset);
                }

                // produce requested plots
                if (plots.length > 0) {
                    var dataseries = []; // plots we want
                    $.each(plots,function(index,signal) {
                        dataseries.push(new_dataset(signal));
                    });

                    // callback to use if user wants to add a new plot
                    dataseries.add_plot = add_plot;  

                    // graph the result and display in a window
                    var graph1 = jade.plot.graph(dataseries);
                    var offset = $(diagram.canvas).offset();
                    var win = jade.window('Test Results',graph1,offset);

                    // resize window to 75% of test pane
                    var win_w = win.width();
                    var win_h = win.height();
                    win[0].resize(Math.floor(0.75*$(diagram.canvas).width()) - win_w,
                                  Math.floor(0.75*$(diagram.canvas).height()) - win_h);
                }
                return undefined;
            } else {
                progress[0].update_progress(percent_complete);
                return progress[0].stop_requested;
            }
        }

        // do the simulation
        var progress = jade.progress_report();
        jade.window('Progress',progress[0],$(diagram.canvas).offset());
        if (mode == 'device')
            jade.cktsim.transient_analysis(netlist, time, Object.keys(sampled_signals), process_results);
        else if (mode == 'gate')
            jade.gatesim.transient_analysis(netlist, time, Object.keys(sampled_signals), process_results);
        else 
            throw 'Unrecognized simulation mode: '+mode;
    };

    // add netlist elements to drive input nodes
    // for device simulation, each input node has a pullup and pulldown FET
    // with the fet gate waveforms chosen to produce 0, 1 or Z
    function build_inputs_device(netlist,driven_signals,thresholds) {
        // add pullup and pulldown FETs for driven nodes, connected to sources for Voh and Vol
        netlist.push({type: 'voltage source',
                      connections:{nplus: '_Voh_', nminus: 'gnd'},
                      properties:{name: '_Voh_source', value:{type:'dc',args:[thresholds.Voh]}}});
        netlist.push({type: 'voltage source',
                      connections:{nplus: '_Vol_', nminus: 'gnd'},
                      properties:{name: '_Voh_source', value:{type:'dc',args:[thresholds.Vol]}}});
        $.each(driven_signals,function(node) {
            netlist.push({type:'pfet',
                          connections:{D:'_Voh_', G:node+'_pullup', S:node},
                          properties:{W:8, L:1,name:node+'_pullup'}});
            netlist.push({type:'nfet',
                          connections:{D:node ,G:node+'_pulldown', S:'_Vol_'},
                          properties:{W:8, L:1,name:node+'_pulldown'}});
        });

        // construct PWL voltage sources to control pullups/pulldowns for driven nodes
        $.each(driven_signals,function(node,tvlist) {
            var pulldown = [0,thresholds.Vol];   // initial <t,v> for pulldown (off)
            var pullup = [0,thresholds.Voh];     // initial <t,v> for pullup (off)
            // run through tvlist, setting correct values for pullup and pulldown gates
            $.each(tvlist,function(index,tvpair) {
                var t = tvpair[0];
                var v = tvpair[1];
                var pu,pd;
                if (v == '0') {
                    // want pulldown on, pullup off
                    pd = thresholds.Voh;
                    pu = thresholds.Voh;
                }
                else if (v == '1') {
                    // want pulldown off, pullup on
                    pd = thresholds.Vol;
                    pu = thresholds.Vol;
                }
                else if (v == 'Z') {
                    // want pulldown off, pullup off
                    pd = thresholds.Vol;
                    pu = thresholds.Voh;
                }
                else
                    console.log('node: '+node+', tvlist: '+JSON.stringify(tvlist));
                // ramp to next control voltage over 0.1ns
                var last_pu = pullup[pullup.length - 1];
                if (last_pu != pu) {
                    if (t != pullup[pullup.length - 2])
                        pullup.push.apply(pullup,[t,last_pu]);
                    pullup.push.apply(pullup,[t+0.1e-9,pu]);
                }
                var last_pd = pulldown[pulldown.length - 1];
                if (last_pd != pd) {
                    if (t != pulldown[pulldown.length - 2])
                        pulldown.push.apply(pulldown,[t,last_pd]);
                    pulldown.push.apply(pulldown,[t+0.1e-9,pd]);
                }
            });
            // set up voltage sources for gates of pullup and pulldown
            netlist.push({type: 'voltage source',
                          connections: {nplus: node+'_pullup', nminus: 'gnd'},
                          properties: {name: node+'_pullup_source', value: {type: 'pwl', args: pullup}}});
            netlist.push({type: 'voltage source',
                          connections: {nplus: node+'_pulldown', nminus: 'gnd'},
                          properties: {name: node+'_pulldown_source', value: {type: 'pwl', args: pulldown}}});
        });
    }

    // add netlist elements to drive input nodes
    // for gate simulation, each input node is connected to a tristate driver
    // with the input and enable waveforms chosen to produce 0, 1 or Z
    function build_inputs_gate(netlist,driven_signals,thresholds) {
        // add tristate drivers for driven nodes
        $.each(driven_signals,function(node) {
            netlist.push({type:'tristate',
                          connections:{E:node+'_enable', A:node+'_data', Z:node},
                          properties:{name: node+'_input_driver', tcd: 0, tpd: 100e-12, tr: 5000, tf: 5000, cin:0, size:0}});
        });


        // construct PWL voltage sources to control data and enable inputs for driven nodes
        $.each(driven_signals,function(node,tvlist) {
            var e_pwl = [0,thresholds.Vol];   // initial <t,v> for enable (off)
            var a_pwl = [0,thresholds.Vol];     // initial <t,v> for pullup (0)
            // run through tvlist, setting correct values for pullup and pulldown gates
            $.each(tvlist,function(index,tvpair) {
                var t = tvpair[0];
                var v = tvpair[1];
                var E,A;
                if (v == '0') {
                    // want enable on, data 0
                    E = thresholds.Voh;
                    A = thresholds.Vol;
                }
                else if (v == '1') {
                    // want enable on, data 1
                    E = thresholds.Voh;
                    A = thresholds.Voh;
                }
                else if (v == 'Z' || v=='-') {
                    // want enable off, data is don't care
                    E = thresholds.Vol;
                    A = thresholds.Vol;
                }
                else
                    console.log('node: '+node+', tvlist: '+JSON.stringify(tvlist));
                // ramp to next control voltage over 0.1ns
                var last_E = e_pwl[e_pwl.length - 1];
                if (last_E != E) {
                    if (t != e_pwl[e_pwl.length - 2])
                        e_pwl.push.apply(e_pwl,[t,last_E]);
                    e_pwl.push.apply(e_pwl,[t+0.1e-9,E]);
                }
                var last_A = a_pwl[a_pwl.length - 1];
                if (last_A != A) {
                    if (t != a_pwl[a_pwl.length - 2])
                        a_pwl.push.apply(a_pwl,[t,last_A]);
                    a_pwl.push.apply(a_pwl,[t+0.1e-9,A]);
                }
            });
            // set up voltage sources for enable and data
            netlist.push({type: 'voltage source',
                          connections: {nplus: node+'_enable', nminus: 'gnd'},
                          properties: {name: node+'_enable_source', value: {type: 'pwl', args: e_pwl}}});
            netlist.push({type: 'voltage source',
                          connections: {nplus: node+'_data', nminus: 'gnd'},
                          properties: {name: node+'_data_source', value: {type: 'pwl', args: a_pwl}}});
        });
    }

    ///////////////////////////////////////////////////////////////////////////////
    //
    // Module exports
    //
    //////////////////////////////////////////////////////////////////////////////

    return {
    };

}());
