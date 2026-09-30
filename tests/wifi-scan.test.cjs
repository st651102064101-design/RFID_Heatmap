// Fault-injection tests. These validate lifecycle handling, not internet speed.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const html=fs.readFileSync('rfid_heatmap_mobile_prototype_fixed.html','utf8');
const java=fs.readFileSync('android-tc501/app/src/main/java/com/kriangkrai/rfidheatmap/MainActivity.java','utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
test('entire application JavaScript parses',()=>new vm.Script(script));
test('both resume actions prepare the active floor plan before opening scan',()=>{
  assert.match(script,/function resumeActiveProjectScan\(\)[\s\S]*?getActiveProjectFloorPlanSource\(\)[\s\S]*?image\.src=source[\s\S]*?showScreen\('scan'\)/);
  assert.match(script,/getElementById\('resumeScan'\)\.onclick=resumeActiveProjectScan/);
  assert.match(script,/getElementById\('resumeProjectScan'\)\.onclick=\(\)=>\{[\s\S]*?resumeActiveProjectScan\(\)/);
});
function harness(load){
  const timers=new Map(); let timerId=0; const engines=[];
  class Engine{
    constructor(){engines.push(this);this.paused=0;this.played=0;}
    play(){this.played++;}
    pause(){this.paused++;}
  }
  const context=vm.createContext({
    Error,
    ensureCloudflareSpeedTestLoaded:load||(()=>Promise.resolve(Engine)),
    setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},
    clearTimeout:id=>timers.delete(id),
  });
  vm.runInContext('let activeInternetSpeedTest=null; let cancelActiveInternetSpeedTest=null;'+
    script.slice(script.indexOf('function runCloudflareDownloadTest('),script.indexOf('function stopCurrentScan(')),context);
  return {context,engines,timers,Engine,run:()=>vm.runInContext('runCloudflareDownloadTest(()=>{})',context),cancel:()=>vm.runInContext('cancelActiveInternetSpeedTest()',context)};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('real engine result is converted from bits/s to Mbps and cleaned up',async()=>{
  const h=harness();const promise=h.run();await flush();
  h.engines[0].onFinish({getDownloadBandwidth:()=>123456789});
  assert.equal(await promise,123.456789);assert.equal(h.timers.size,0);assert.equal(h.engines[0].paused,1);
});
test('cancel while module is loading cannot start a stale engine',async()=>{
  let resolveLoad;const h=harness(()=>new Promise(resolve=>{resolveLoad=resolve;}));
  const promise=h.run();const rejected=assert.rejects(promise,/canceled/);h.cancel();
  resolveLoad(h.Engine);await rejected;await flush();assert.equal(h.engines.length,0);assert.equal(h.timers.size,0);
});
test('stop then restart ignores a late completion from the stopped scan',async()=>{
  const h=harness();const first=h.run();await flush();const late=h.engines[0].onFinish;
  const rejected=assert.rejects(first,/canceled/);h.cancel();await rejected;
  const second=h.run();await flush();late({getDownloadBandwidth:()=>999e6});
  h.engines[1].onFinish({getDownloadBandwidth:()=>25e6});assert.equal(await second,25);
});
test('timeout includes module loading and leaves no background engine',async()=>{
  const h=harness(()=>new Promise(()=>{}));const promise=h.run();
  const rejected=assert.rejects(promise,/timed out/);[...h.timers.values()][0]();await rejected;assert.equal(h.timers.size,0);
});
test('network failure pauses engine and rejects result',async()=>{
  const h=harness();const promise=h.run();await flush();
  const rejected=assert.rejects(promise,/network failed/);h.engines[0].onError('network failed');await rejected;
  assert.equal(h.engines[0].paused,1);assert.equal(h.timers.size,0);
});
test('zero, missing, negative and nonfinite measurements cannot become saved speeds',async()=>{
  for(const value of [0,undefined,-1,NaN,Infinity]){
    const h=harness();const promise=h.run();await flush();const rejected=assert.rejects(promise,/could not measure/);
    h.engines[0].onFinish({getDownloadBandwidth:()=>value});await rejected;
  }
});
test('module failure rejects cleanly and retry works',async()=>{
  const h=harness();h.context.ensureCloudflareSpeedTestLoaded=()=>Promise.reject(new Error('load failed'));
  await assert.rejects(h.run(),/load failed/);assert.equal(h.timers.size,0);
  h.context.ensureCloudflareSpeedTestLoaded=()=>Promise.resolve(h.Engine);
  const promise=h.run();await flush();h.engines[0].onFinish({getDownloadBandwidth:()=>42e6});assert.equal(await promise,42);
});

test('TC501 results require real negative tag RSSI and report an aggregate',()=>{
  const start=script.indexOf('function getRfidScanSummary(');
  const end=script.indexOf('function updateScanMeasurementNote(',start);
  const context=vm.createContext({Map,Number,String,Array});
  vm.runInContext(script.slice(start,end),context);
  const valid=vm.runInContext(`getRfidScanSummary({tags:[
    {epc:'tag-a',peakRssiDbm:-60,seenCount:5},
    {epc:'tag-a',peakRssiDbm:-64,seenCount:3},
    {epc:'tag-b',peakRssiDbm:-80,seenCount:2},
    {epc:'bad',peakRssiDbm:4,seenCount:1}
  ]})`,context);
  assert.equal(valid.meanPeakRssiDbm,-70);
  assert.equal(valid.tagCount,2);
  assert.equal(valid.readCount,10);
  assert.equal(vm.runInContext(`getRfidScanSummary({tags:[{epc:'bad',peakRssiDbm:0}]})`,context),null);
  assert.equal(vm.runInContext(`getRfidScanSummary({tags:[]})`,context),null);
});

test('RFID heatmap accepts only saved TC501 RSSI instead of synthesizing location values',()=>{
  const start=script.indexOf('function getHeatmapPoints(');
  const end=script.indexOf('function heatColorForStrength(',start);
  const heatmapFunction=script.slice(start,end);
  assert.match(heatmapFunction,/saved\.rfidRssiDbm\?\?saved\.signalStrengthDbm/);
  assert.doesNotMatch(heatmapFunction,/distanceFromCenter|78\s*-\s*distance/);
  assert.match(script,/window\.TC501Rfid\.startInventory/);
});

test('heatmap uses a fixed screen-center dot instead of a person; estimate follows the center while panning',()=>{
  assert.match(html,/id="heatmapCenterMarker"/);
  assert.match(html,/class="heatmap-center-value" id="heatmapValue"/);
  assert.match(html,/class="heatmap-center-dot"/);
  assert.match(html,/\.heatmap-center-marker\{[^}]*left:50%;top:50%;[^}]*pointer-events:none/);
  assert.doesNotMatch(html,/heatmap-person|heat-person-(?:limbs|body|head|device)|heatmapCenterMarker[\s\S]{0,400}<svg/);
  assert.doesNotMatch(html,/\.heatmap-screen \.heatmap-legend\{display:none\}/);
  assert.match(html,/id="heatmapValue"/);
  assert.match(script,/stage\.clientWidth\/2-left-heatmapPan\.x/);
  assert.match(script,/stage\.clientHeight\/2-top-heatmapPan\.y/);
});

test('RFID no-read scan points remain visible as no-data markers, never heat values',()=>{
  const start=script.indexOf('function getHeatmapPoints(');
  const end=script.indexOf('function heatColorForStrength(',start);
  const context=vm.createContext({
    document:{getElementById:id=>id==='scanMap'?{clientWidth:100,clientHeight:100}:{}} ,
    savedScanPoints:[{wifiImage:{x:24,y:61},signalStrengthDbm:null,measurementSource:'zebra-rfid-sdk',rfidDetected:false}],
    activeProductType:'rfid',getContainedImageBounds:()=>({left:0,top:0,width:100,height:100}),Number,Math
  });
  vm.runInContext(script.slice(start,end),context);
  const point=vm.runInContext('getHeatmapPoints(100)[0]',context);
  assert.equal(point.noRead,true);
  assert.equal(point.measured,false);
  assert.equal(point.metricValue,undefined);
  assert.match(html,/heatmap-no-read-mark/);
  assert.match(html,/No RFID data at these scan points/);
  assert.match(html,/id="heatmapRescan"/);
});
test('unmeasured areas use the original gray heatmap overlay',()=>{
  assert.match(html,/#heatmapStage\[data-gray-unmeasured="true"\] \.heatmap-colors\{background-color:rgba\(145,145,145,\.68\)\}/);
  assert.doesNotMatch(html,/heatmap-floor,[\s\S]*?filter:grayscale\(1\)/);
});

test('auto-created example projects are removed while user projects are preserved',()=>{
  assert.doesNotMatch(html,/seedWifiExampleProject\(\)|duplicateProjectOneAsSample\(\)/);
  const start=script.indexOf('function removeGeneratedProjectExamples(');
  const end=script.indexOf('function beginNewProject(',start);
  const cards=new Map();
  const removedKeys=[];
  const stored={};
  const context=vm.createContext({
    createdProjects:[
      {id:'wifi-example-warehouse',name:'Warehouse A - WiFi Survey',zones:[]},
      {id:'project-123-duplicate',name:'Warehouse A - RFID Survey',zones:[{id:'z1',snapshots:[{number:1}]}]},
      {id:'project-456',name:'Project 1',zones:[]},
      {id:'my-project',name:'My project',zones:[]}
    ],
    CSS:{escape:value=>value},
    document:{querySelectorAll:selector=>{
      const id=selector.match(/data-project-id="([^"]+)"/)?.[1];
      return id&&cards.has(id)?[cards.get(id)]:[];
    }},
    localStorage:{removeItem:key=>removedKeys.push(key),setItem:(key,value)=>{stored[key]=value}},
    getScanStoragePrefix:()=> 'scan:',
    getSnapshotScanStorageKey:(id,zone,number)=>`scan:${id}:${zone}:${number}`,
    getCreatedProjectsKey:()=> 'projects:'
  });
  vm.runInContext(script.slice(start,end)+'\nremoveGeneratedProjectExamples();',context);
  assert.deepEqual(Array.from(context.createdProjects,project=>project.name),['Project 1','My project']);
  assert.equal(JSON.parse(stored['projects:']).length,2);
  assert.ok(removedKeys.includes('scan:wifi-example-warehouse'));
  assert.ok(removedKeys.includes('scan:project-123-duplicate'));
  assert.ok(removedKeys.includes('scan:project-123-duplicate:z1:1'));
});

test('completed RFID scans accept any readable tag; completed empty scans save no-read and failures are rejected',()=>{
  const start=script.indexOf('function getRfidScanSummary(');
  const end=script.indexOf('function updateScanMeasurementNote(',start);
  const context=vm.createContext({Map,Number,String,Array});
  vm.runInContext(script.slice(start,end),context);
  const result=vm.runInContext("getRfidScanSummary({completed:true,mode:'fixed-reader',targetEpc:'ABCD',tags:[]})",context);
  assert.equal(result.meanPeakRssiDbm,null);
  assert.equal(result.readCount,0);
  assert.equal(result.detected,false);
  assert.equal(vm.runInContext("getRfidScanSummary({completed:false,mode:'fixed-reader',targetEpc:'ABCD',tags:[]})",context),null);
  const otherOnly=vm.runInContext("getRfidScanSummary({completed:true,mode:'fixed-reader',tags:[{epc:'OTHER',peakRssiDbm:-40}]})",context);
  assert.equal(otherOnly.detected,true);
  assert.equal(otherOnly.meanPeakRssiDbm,-40);
  const otherReferenceTag=vm.runInContext("getRfidScanSummary({completed:true,mode:'reference-tag',targetEpc:'TARGET',tags:[{epc:'OTHER',peakRssiDbm:-40}]})",context);
  assert.equal(otherReferenceTag.detected,true);
  assert.equal(otherReferenceTag.meanPeakRssiDbm,-40);
  assert.match(java,/if \(prefs\.getString\("mode", ""\)\.isEmpty\(\)\)/);
  assert.doesNotMatch(java,/if \(targetEpc\.isEmpty\(\)\)/);
  assert.match(java,/activeTargetEpc = ""/);
});

test('completed scans with other EPCs do not report a false no-read or selected-EPC alert',()=>{
  const start=script.indexOf('window.onTC501RfidInventoryComplete=');
  const end=script.indexOf('window.onTC501RfidError=',start);
  const handler=script.slice(start,end);
  assert.doesNotMatch(handler,/selected EPC/);
  assert.match(handler,/summary\?\.tagCount===0/);
  assert.match(handler,/No readable RFID tag at this point; saved as no signal/);
});
test('RFID setup hides fixed-reader credentials but preserves saved connection settings',()=>{
  const setup=java.slice(java.indexOf('private void showRfidSetup()'),java.indexOf('private void beginTagDiscovery('));
  assert.doesNotMatch(setup,/Reader IP|Username|Password|Advanced settings/);
  assert.match(setup,/\.putString\("mode"/);
  assert.match(java,/prefs\.getString\("fixedHost", ""\)/);
  assert.match(java,/prefs\.getString\("fixedUsername", ""\)/);
  assert.match(java,/prefs\.getString\("fixedPassword", ""\)/);
});

test('fixed-reader signal summary uses real RSSI from all observed tags without EPC selection',()=>{
  const start=script.indexOf('function getRfidScanSummary(');
  const end=script.indexOf('function updateScanMeasurementNote(',start);
  const context=vm.createContext({Map,Number,String,Array});
  vm.runInContext(script.slice(start,end),context);
  const summary=vm.runInContext(`getRfidScanSummary({mode:'fixed-reader',targetEpc:'WALKER',tags:[
    {epc:'OTHER',peakRssiDbm:-35,seenCount:100},
    {epc:'walker',peakRssiDbm:-78,seenCount:4}
  ]})`,context);
  assert.equal(summary.meanPeakRssiDbm,-56.5);
  assert.equal(summary.tagCount,2);
  assert.equal(summary.readCount,104);
  const record=script.slice(script.indexOf('function recordScanPoint('),script.indexOf('activateProjectScanData(activeProjectId)',script.indexOf('function recordScanPoint(')));
  assert.match(record,/rfidReports=Array\.isArray\(rfidScanResult\?\.tags\)\?rfidScanResult\.tags:\[\]/);
  const handler=script.slice(script.indexOf('window.onTC501RfidInventoryComplete='),script.indexOf('window.onTC501RfidError='));
  assert.doesNotMatch(handler,/epcs\.length&&result\?\.mode!=='fixed-reader'/);
});
test('each RFID point stores measured RSSI and displays it explicitly as RSSI in dBm',()=>{
  const record=script.slice(script.indexOf('function recordScanPoint('),script.indexOf('activateProjectScanData(activeProjectId)',script.indexOf('function recordScanPoint(')));
  assert.match(record,/rfidRssiDbm:rfidSummary\?\.meanPeakRssiDbm\?\?null/);
  assert.match(record,/rfidReports,downloadMbps/);
  assert.match(script,/valueElement\.textContent=`RSSI \$\{signalDbm\.toFixed\(1\)\} dBm est\.`/);
  assert.match(script,/`RSSI \$\{summary\.meanPeakRssiDbm\.toFixed\(1\)\} dBm/);
});
test('RSSI is never extrapolated far from scan points and heat colors are spatially bounded',()=>{
  const start=script.indexOf('function getHeatmapSupportRadius(');
  const end=script.indexOf('function setHeatmapUnmeasured(',start);
  const context=vm.createContext({Math,Number});
  vm.runInContext(script.slice(start,end),context);
  const points=[{x:20,y:20},{x:80,y:80}];
  context.points=points;
  assert.equal(vm.runInContext('getNearbyHeatmapPoints(points,{x:50,y:50}).length',context),0);
  assert.equal(vm.runInContext('getNearbyHeatmapPoints(points,{x:22,y:22}).length',context),1);
  assert.match(script,/No nearby RSSI scan was recorded\. RSSI is not extrapolated from distant points/);
  assert.match(script,/radial-gradient\(ellipse \$\{radius\.x\}% \$\{radius\.y\}% at \$\{point\.x\}% \$\{point\.y\}%/);
  const gridPoints=[{x:20,y:20,scanCellSizeX:20,scanCellSizeY:10}];
  context.gridPoints=gridPoints;
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('getHeatmapSupportRadius(gridPoints,0)',context))),{x:10,y:5});
  assert.equal(vm.runInContext('getNearbyHeatmapPoints(gridPoints,{x:29,y:20}).length',context),1);
  assert.equal(vm.runInContext('getNearbyHeatmapPoints(gridPoints,{x:31,y:20}).length',context),0);
});

test('RFID progress and bridge share the requested fast scan duration',()=>{
  const start=script.indexOf('function startTc501RfidScan(');
  const end=script.indexOf("document.addEventListener('visibilitychange'",start);
  const context=vm.createContext({
    window:{TC501RfidBridge:{getScanDurationMs:()=>1000},TC501Rfid:{startInventory:(id,ms)=>{context.requested=ms;},stopInventory:()=>{}}},
    performance:{now:()=>0},requestAnimationFrame:()=>1,setTimeout:()=>1,navigator:{},Number,
    setScanProgress:()=>{},
  });
  vm.runInContext('let scanActive=false,tc501RfidRunId=0,activeTc501RfidRun=null,scanProgressFrame,tc501RfidTimeout; const scanProgressDuration=6000;'+script.slice(start,end),context);
  const screen={classList:{add:()=>{}}},button={setAttribute:()=>{}};
  context.startTc501RfidScan(screen,button,{},{});
  assert.equal(context.requested,1000);
  context.window.TC501RfidBridge.getScanDurationMs=()=>6000;
  context.startTc501RfidScan(screen,button,{},{});
  assert.equal(context.requested,6000);
});

test('RFID stop cancels pending result before bridge call and ignores late completion',()=>{
  const start=script.indexOf('function stopCurrentScan(');
  const end=script.indexOf('window.onTC501RfidError=',start);
  let stopped=0,finished=0;
  const context=vm.createContext({
    window:{TC501Rfid:{stopInventory:id=>{assert.equal(id,7);stopped++;assert.equal(vm.runInContext('activeTc501RfidRun',context),null);}}},
    clearTimeout:()=>{},console,finishScan:save=>{assert.equal(save,false);finished++;},
  });
  vm.runInContext('let wifiScanRunId=0,activeTc501RfidRun=7,tc501RfidTimeout=1,cancelActiveInternetSpeedTest=null;'+script.slice(start,end),context);
  context.stopCurrentScan();
  context.window.onTC501RfidInventoryComplete(7,'{}');
  assert.equal(stopped,1);
  assert.equal(finished,1);
});
