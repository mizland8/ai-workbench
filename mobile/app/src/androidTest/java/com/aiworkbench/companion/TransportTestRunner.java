package com.aiworkbench.companion;
import android.app.Instrumentation;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Opt-in test of a localhost-only Rust TLS fixture through adb reverse. Does not alter user PCs. */
public class TransportTestRunner extends Instrumentation {
    @Override public void onCreate(Bundle args){super.onCreate(args);start();}
    private void require(boolean condition,String reason)throws Exception{if(!condition)throw new Exception(reason);}
    @Override public void onStart(){
        Bundle results=new Bundle();String id="transport-test-"+UUID.randomUUID();LinkClient client=new LinkClient(getTargetContext());
        try{
            ParcelFileDescriptor file=getUiAutomation().executeShellCommand("cat /data/local/tmp/aiw-companion-test-pairing.json");
            String code;try(InputStream in=new ParcelFileDescriptor.AutoCloseInputStream(file)){ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] bytes=new byte[4096];int n;while((n=in.read(bytes))!=-1)out.write(bytes,0,n);code=out.toString("UTF-8");}
            JSONObject pc=client.pair(code,"Android transport test");require(pc.has("token"),"Pairing token missing");
            client.save(id,pc);JSONObject restored=client.load(id);require(restored.getString("token").equals(pc.getString("token")),"Encrypted credential roundtrip failed");
            JSONObject snapshot=client.request(restored,"snapshot",null);require(snapshot.getJSONObject("snapshot").getJSONArray("projects").getJSONObject(0).getString("name").equals("Transport test"),"Snapshot mismatch");
            JSONObject message=new JSONObject().put("id",UUID.randomUUID().toString()).put("chatId","fixture-chat").put("text","Transport test only");
            require(client.request(restored,"message",message).getString("status").equals("queued"),"No send receipt");
            boolean rejected=false;try{client.pair(code,"Repeated pairing");}catch(Exception expected){rejected=true;}require(rejected,"Pairing code was reused");
            JSONObject wrong=new JSONObject(pc.toString());String cert=wrong.getString("cert");wrong.put("cert",(cert.startsWith("00")?"01":"00")+cert.substring(2));
            rejected=false;try{client.request(wrong,"snapshot",null);}catch(Exception expected){rejected=true;}require(rejected,"Wrong certificate was accepted");
            wrong=new JSONObject(pc.toString()).put("token","not-authorized");rejected=false;try{client.request(wrong,"snapshot",null);}catch(Exception expected){rejected=true;}require(rejected,"Wrong credential was accepted");
            results.putString("stream","PASS: TLS pinning, single-use pairing, Keystore credentials, snapshots, message receipt, invalid token rejection\n");finish(-1,results);
        }catch(Exception e){results.putString("stream","FAIL: "+e.toString()+"\n");finish(0,results);}
        finally{client.forget(id);}
    }
}
