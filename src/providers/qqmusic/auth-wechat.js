// Standalone protocol module. randomBytes must be cryptographically secure.
const APP = 'wx48db31d50e334801';
const CONNECT = 'https://open.weixin.qq.com/connect/qrconnect';
const MUSIC = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const MOD = 'c4231830a2eb5fc2827170641e79d80fec51bda9a22e4b4ab37d1f205a4ae44d928cda25879f66a3429051663312a127faf8a246bdaaf63918417e90d7c95b5908aa6a2d0f852e4a6770294a548ac1c2fe8f1f252fb826f4ac86ab9a00e7ce47d002a56e7c4b51eb889acc60ca6adbc9f72e81f4d31b1dd7464805264530ab1d';
function bytes(s) { const t=encodeURIComponent(s), a=[]; for(let i=0;i<t.length;i++) { if(t[i]==='%') { a.push(parseInt(t.slice(i+1,i+3),16)); i+=2; } else a.push(t.charCodeAt(i)); } return a; }
function hex(a) { return Array.from(a,x=>x.toString(16).padStart(2,'0')).join(''); }
function b64(a) { const c='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; let s=''; for(let i=0;i<a.length;i+=3) { const n=(a[i]<<16)|((a[i+1]||0)<<8)|(a[i+2]||0); s+=c[n>>>18]+c[n>>>12&63]+(i+1<a.length?c[n>>>6&63]:'=')+(i+2<a.length?c[n&63]:'='); } return s; }
function md5(text) {
  const a=bytes(text), len=a.length*8; a.push(128); while(a.length%64!==56)a.push(0); for(let i=0;i<8;i++)a.push(Math.floor(len/2**(8*i))&255);
  const shifts=[7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21]; let h=[0x67452301,0xefcdab89,0x98badcfe,0x10325476];
  for(let off=0;off<a.length;off+=64) { const w=[]; for(let i=0;i<16;i++)w.push(a[off+i*4]|a[off+i*4+1]<<8|a[off+i*4+2]<<16|a[off+i*4+3]<<24); let [x,y,z,t]=h;
    for(let i=0;i<64;i++) { let f,g; if(i<16){f=y&z|~y&t;g=i;}else if(i<32){f=t&y|~t&z;g=(5*i+1)%16;}else if(i<48){f=y^z^t;g=(3*i+5)%16;}else{f=z^(y|~t);g=7*i%16;} const v=(x+f+w[g]+Math.floor(Math.abs(Math.sin(i+1))*4294967296))|0, n=shifts[(i>>4)*4+i%4]; x=t;t=z;z=y;y=(y+(v<<n|v>>>(32-n)))|0; }
    h=h.map((v,i)=>(v+[x,y,z,t][i])|0);
  } return hex(h.flatMap(v=>[v&255,v>>>8&255,v>>>16&255,v>>>24&255]));
}
function mul(a,b) { let r=0; for(let i=0;i<8;i++){if(b&1)r^=a;a=((a<<1)^((a&128)?0x11b:0))&255;b>>=1;}return r; }
function aesCBC(key,plain) {
  const box=[]; for(let x=0;x<256;x++){let inv=1;if(!x)inv=0;else for(let i=0;i<254;i++)inv=mul(inv,x);const rot=n=>(inv<<n|inv>>(8-n))&255;box[x]=inv^rot(1)^rot(2)^rot(3)^rot(4)^0x63;}
  const rk=key.slice();let rc=1;while(rk.length<176){let t=rk.slice(-4);if(rk.length%16===0){t=[box[t[1]]^rc,box[t[2]],box[t[3]],box[t[0]]];rc=mul(rc,2);}for(let i=0;i<4;i++)rk.push(rk[rk.length-16]^t[i]);}
  const pad=16-plain.length%16, data=plain.concat(Array(pad).fill(pad)), out=[];let prev=key.slice();
  for(let off=0;off<data.length;off+=16){let s=data.slice(off,off+16).map((v,i)=>v^prev[i]^rk[i]);for(let r=1;r<=10;r++){s=s.map(v=>box[v]);s=s.map((_,i)=>s[i%4+4*((Math.floor(i/4)+i%4)%4)]);if(r<10)for(let c=0;c<4;c++){const i=c*4,[a,b,d,e]=s.slice(i,i+4);s[i]=mul(a,2)^mul(b,3)^d^e;s[i+1]=a^mul(b,2)^mul(d,3)^e;s[i+2]=a^b^mul(d,2)^mul(e,3);s[i+3]=mul(a,3)^b^d^mul(e,2);}s=s.map((v,i)=>v^rk[r*16+i]);}out.push(...s);prev=s;}return out;
}
function secureRandom(deps) { const fn=deps.randomBytes||(globalThis.crypto&&globalThis.crypto.getRandomValues&&(n=>globalThis.crypto.getRandomValues(new Uint8Array(n)))); if(typeof fn!=='function')throw new Error('WeChat login requires a cryptographically secure randomBytes(n) provider');return n=>{const a=fn(n);if(!a||a.length!==n||Array.from(a).some(x=>!Number.isInteger(x)||x<0||x>255))throw new Error('Invalid randomBytes');return Array.from(a);}; }
function digits(random,n){let s='';while(s.length<n)for(const b of random(n-s.length))if(b<250)s+=String(b%10);return s;}
function rsa(random,message){if(typeof BigInt!=='function')throw new Error('WeChat login requires BigInt');const pad=[];while(pad.length<109)for(const b of random(109-pad.length))if(b)pad.push(b);let v=BigInt('0x'+hex([0,2,...pad,0,...bytes(message)])),n=BigInt('0x'+MOD),out=BigInt(1),e=65537;while(e){if(e%2)out=out*v%n;v=v*v%n;e=Math.floor(e/2);}const h=out.toString(16).padStart(256,'0'),a=[];for(let i=0;i<h.length;i+=2)a.push(parseInt(h.slice(i,i+2),16));return b64(a);}
function device(random){const androidId=hex(random(8)),openUdid=hex(random(16)),base=digits(random,14);let sum=0;for(let i=0;i<14;i++){let n=Number(base[i]);if(i%2){n*=2;if(n>9)n-=9;}sum+=n;}return {androidId,openUdid,imei:base+(10-sum%10)%10,qimei:'',qimei36:'',uid:'',sid:''};}
export function wechatDeviceComm(d){return {ct:11,cv:14090008,v:14090008,chid:'10003505',tmeAppID:'qqmusic',QIMEI:d.qimei,QIMEI36:d.qimei36,OpenUDID:d.openUdid,udid:d.openUdid,OpenUDID2:d.openUdid,aid:d.androidId,os_ver:'10',phonetype:'MI 6',devicelevel:'29',newdevicelevel:'29',rom:'xiaomi/iarim/sagit:10/eomam.200122.001/2001221:user/release-keys',...(d.uid?{uid:d.uid,sid:d.sid}:{})};}
const comm = wechatDeviceComm;
function envelope(d,random,now){
  const appKey='0AND0HD6FE4HY80F',key=hex(random(8)),nonce=hex(random(8)),first=digits(random,6),second=digits(random,9),month=now.toISOString().slice(0,7),dated=[1,2,13,14,17,18,21,22,25,26,29,30,33,34,37,38];
  let beacon='';for(let i=1;i<=40;i++)beacon+='k'+i+':'+(i===3?'0000000000000000':i===4?key.replace(/0/g,'1'):dated.includes(i)?month+'-01'+first+'.'+second:digits(random,4))+';';
  const reserved={harmony:'0',clone:'0',containe:'',oz:'UhYmelwouA+V2nPWbOvLTgN2/m8jwGB+yUB5v9tysQg=',oo:'Xecjt+9S1+f8Pz2VLSxgpw==',kelong:'0',uptimes:new Date(now.getTime()-3600000).toISOString().slice(0,19).replace('T',' '),multiUser:'0',bod:'Xiaomi',dv:'sagit',firstLevel:'',manufact:'Xiaomi',name:'MI 6',host:'se.infra',kernel:'Linux 5.4.0-54-generic (android-build@google.com)'};
  const payload={androidId:d.androidId,platformId:1,appKey,appVersion:'14.9.0.8',beaconIdSrc:beacon,brand:'Xiaomi',channelId:'10003505',cid:'',imei:d.imei,imsi:'',mac:'',model:'MI 6',networkType:'unknown',oaid:'',osVersion:'Android 10,level 29',qimei:'',qimei36:'',sdkVersion:'1.2.13.6',targetSdkVersion:'33',audit:'',userId:'{}',packageId:'com.tencent.qqmusic',deviceType:'Phone',sdkName:'',reserved:JSON.stringify(reserved)};
  const wrapped=rsa(random,key),params=b64(aesCBC(bytes(key),bytes(JSON.stringify(payload)))),time=String(Math.floor(now.getTime()/1000)),extra=JSON.stringify({appKey});
  return {body:JSON.stringify({app:0,os:1,qimeiParams:{key:wrapped,params,time,nonce,sign:md5(wrapped+params+time+'000'+nonce+'ZdJqM15EeO2zWc08'+extra),extra}}),headers:{Method:'GetQimei',Service:'trpc.tme_datasvr.qimeiproxy.QimeiProxy',Appid:'qimei_qq_android',Sign:md5('qimei_qq_androidpzAuCmaFAaFaHrdakPjLIEqKrGnSOOvH'+time),Timestamp:time,'Content-Type':'application/json','User-Agent':'QQMusic'}};
}
function object(value){try{return typeof value==='string'?JSON.parse(value):value;}catch{throw new Error('Malformed QIMEI response');}}
function checked(body, name) {
  if (!body || typeof body.code !== 'number' || typeof body[name]?.code !== 'number') throw new Error('QQ Music returned a malformed login response');
  const code = body[name].code || body[name].subcode || 0;
  if (body.code !== 0 || code !== 0) throw Object.assign(new Error('QQ Music rejected login or renewal'), { qqGlobalCode: body.code, qqCode: code });
  if (!body[name].data) throw new Error('QQ Music returned no login data');
  return body[name].data;
}
function session(data,d){const id=data.str_musicid||data.musicid,type=data.loginType||1;if((typeof id!=='string'&&!(typeof id==='number'&&Number.isSafeInteger(id)))||!/^[0-9]+$/.test(String(id))||!/[1-9]/.test(String(id)))throw new Error('Invalid music ID');if(typeof data.musickey!=='string'||!data.musickey||/[;\s]/.test(data.musickey)||Number(type)!==1)throw new Error('Invalid WeChat credential');const created=Number(data.musickeyCreateTime)||0,expires=Number(data.keyExpiresIn)||0;if(created>0&&expires>0&&Date.now()/1000>=created+expires)throw new Error('Expired WeChat credential');const result={musicid:String(id),musickey:data.musickey,loginType:1,device:d};for(const k of ['openid','refresh_token','unionid','refresh_key','nick','logo','encryptUin','musickeyCreateTime','keyExpiresIn'])if(data[k]!==undefined)result[k]=data[k];return result;}
async function request(fetch,url,options={}){const res=await fetch(url,options);if(!res||res.status<200||res.status>=300)throw new Error('WeChat login HTTP '+(res&&res.status));return res;}
function query(p){return Object.keys(p).map(k=>encodeURIComponent(k)+'='+encodeURIComponent(p[k])).join('&');}

// fetch must retain the WeChat cookies across open.weixin.qq.com and its poll host.
export async function wechatSignIn(deps){
  if(!deps||['fetch','prompt','sleep','decodeQR'].some(k=>typeof deps[k]!=='function'))throw new Error('Missing WeChat login dependency');
  const random=secureRandom(deps),d=device(random),fetch=deps.fetch;let now=new Date();
  for(let attempt=0;attempt<2;attempt++){const env=envelope(d,random,now),res=await request(fetch,'https://api.tencentmusic.com/tme/trpc/proxy',{method:'POST',headers:env.headers,body:env.body});const outer=object(await res.json()),inner=object(outer&&outer.data),data=object(inner&&inner.data);if(data&&data.q16&&data.q36){d.qimei=String(data.q16);d.qimei36=String(data.q36);break;}const date=res.headers&&res.headers.get&&Date.parse(res.headers.get('date'));if(!attempt&&Number.isFinite(date)&&Math.abs(now.getTime()-date)>60000){now=new Date(date);continue;}throw new Error('Device bootstrap did not return QIMEI');}
  const headers={'Content-Type':'application/json','User-Agent':'QQMusic 14090008(android 10)',Referer:'https://y.qq.com/'};
  let res=await request(fetch,MUSIC,{method:'POST',headers,body:JSON.stringify({comm:comm(d),req_0:{module:'music.getSession.session',method:'GetSession',param:{uid:'',vkey:0,caller:0}}})});const ds=checked(await res.json(),'req_0').session;if(!ds||ds.uid==null||ds.sid==null||!String(ds.uid)||!String(ds.sid))throw new Error('Missing device session');d.uid=String(ds.uid);d.sid=String(ds.sid);
  const pageURL=CONNECT+'?'+query({appid:APP,redirect_uri:'https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/',response_type:'code',scope:'snsapi_login',state:'STATE',href:'https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect'});
  res=await request(fetch,pageURL,{headers:{'User-Agent':'Mozilla/5.0'}});const page=await res.text(),match=/(?:uuid=|\/connect\/qrcode\/)([A-Za-z0-9_-]+)/.exec(page);if(!match)throw new Error('Missing WeChat QR identifier');const uuid=match[1];
  res=await request(fetch,'https://open.weixin.qq.com/connect/qrcode/'+uuid,{headers:{'User-Agent':'Mozilla/5.0',Referer:CONNECT}});const qr=await deps.decodeQR(new Uint8Array(await res.arrayBuffer()));if(typeof qr!=='string'||!qr)throw new Error('Cannot decode WeChat QR image');await deps.prompt({qr,text:'请使用微信扫码登录'});
  let scanned=false;const deadline=Date.now()+120000;while(Date.now()<deadline){const q={uuid,_:String(Date.now())};if(scanned)q.last='404';res=await request(fetch,'https://lp.open.weixin.qq.com/connect/l/qrconnect?'+query(q),{headers:{'User-Agent':'Mozilla/5.0',Referer:'https://open.weixin.qq.com/'}});const status=/window\.wx_errcode\s*=\s*(\d+)\s*;\s*window\.wx_code\s*=\s*'([^'\r\n]*)'/.exec(await res.text());if(!status)throw new Error('Malformed WeChat QR status');if(status[1]==='402'||status[1]==='403')throw new Error('WeChat QR expired or canceled');if(status[1]==='404'&&!scanned){scanned=true;await deps.prompt({qr,text:'请在微信上确认登录'});}else if(status[1]==='405'){if(!status[2])throw new Error('Missing WeChat authorization code');res=await request(fetch,MUSIC,{method:'POST',headers,body:JSON.stringify({comm:{...comm(d),tmeLoginType:1},req:{module:'music.login.LoginServer',method:'Login',param:{code:status[2],strAppid:APP}}})});return session(checked(await res.json(),'req'),d);}else if(status[1]!=='404'&&status[1]!=='408')throw new Error('Unknown WeChat QR status: '+status[1]);await deps.sleep(1000);}throw new Error('WeChat QR expired');
}

export async function refreshWechatSession(previous, fetch) {
  if (!previous.device || (!previous.refresh_key && !previous.refresh_token)) throw new Error('WeChat session cannot be refreshed');
  const data = { openid: previous.openid || '', refresh_token: previous.refresh_token || '', str_musicid: previous.musicid, musickey: previous.musickey, unionid: previous.unionid || '', refresh_key: previous.refresh_key || '', loginMode: 2 };
  const response = await request(fetch, MUSIC, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'QQMusic 14090008(android 10)', Referer: 'https://y.qq.com/', Cookie: `uin=${previous.musicid}; qqmusic_uin=${previous.musicid}; qm_keyst=${previous.musickey}; qqmusic_key=${previous.musickey}` }, body: JSON.stringify({ comm: { ...comm(previous.device), qq: previous.musicid, authst: previous.musickey, tmeLoginType: 1 }, req: { module: 'music.login.LoginServer', method: 'Login', param: data } }) });
  const next = session(checked(await response.json(), 'req'), previous.device);
  for (const key of ['openid', 'refresh_token', 'unionid', 'refresh_key', 'nick', 'logo', 'encryptUin']) if (!next[key] && previous[key]) next[key] = previous[key];
  return next;
}
