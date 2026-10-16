const {AuthGuard}=require('../dist/modules/auth/auth.guard');
const {tokenHash}=require('../dist/modules/auth/auth.service');
const req={headers:{authorization:`Bearer ${'a'.repeat(43)}`},body:{workspaceId:'untrusted'}};
const context=()=>({getHandler:()=>({}),getClass:()=>({}),switchToHttp:()=>({getRequest:()=>req})});
function guard({role='teacher',session=true,publicRoute=false}={}) {
  const db={collection:name=>name==='authSessions'?{findOne:()=>({lean:async()=>session?{_id:'session',userId:'teacher'}:null})}:{findById:()=>({lean:async()=>({_id:'teacher',name:'Guru',email:'g@example.test',workspaceId:'trusted',timezone:'Asia/Jakarta',role})})}};
  return new AuthGuard({getAllAndOverride:()=>publicRoute},db);
}
test('opaque token hashing is deterministic and does not expose the token',()=>{ expect(tokenHash('secret')).toHaveLength(64); expect(tokenHash('secret')).not.toContain('secret'); expect(tokenHash('secret')).toBe(tokenHash('secret')); });
test('server principal ignores client ownership claims',async()=>{ expect(await guard().canActivate(context())).toBe(true); expect(req.user.workspaceId).toBe('trusted'); });
test('student and parent cannot use teacher APIs',async()=>{ await expect(guard({role:'parent'}).canActivate(context())).rejects.toThrow('khusus guru'); await expect(guard({role:'student'}).canActivate(context())).rejects.toThrow('khusus guru'); });
test('invalid and expired sessions are denied',async()=>{ await expect(guard({session:false}).canActivate(context())).rejects.toThrow('berakhir'); });
test('public health routes do not require a principal',async()=>expect(await guard({publicRoute:true,session:false}).canActivate(context())).toBe(true));
