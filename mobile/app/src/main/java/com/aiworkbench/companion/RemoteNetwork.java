package com.aiworkbench.companion;

import android.content.Context;
import org.json.JSONObject;
import java.io.File;
import java.util.UUID;
import netcore.Netcore;

/** App-only embedded transport. No Android VPN service and no device-wide traffic routing. */
final class RemoteNetwork {
    private static boolean started=false,diagnostics=false;
    private static java.io.FileOutputStream nativeLog;
    static synchronized void captureNativeLogs(Context context)throws Exception{
        if(diagnostics)return;
        nativeLog=new java.io.FileOutputStream(new File(context.getCacheDir(),"native-network-startup.log"),false);
        android.system.Os.dup2(nativeLog.getFD(),2);diagnostics=true;
    }
    static boolean enabled(Context context){return context.getSharedPreferences("remote-network",0).getBoolean("enabled",false);}
    static synchronized void start(Context context)throws Exception{
        if(started)return;
        if(!enabled(context))throw new Exception("Enable built-in remote access in Computers first");
        captureNativeLogs(context);
        go.Seq.setContext(context.getApplicationContext());
        android.content.SharedPreferences prefs=context.getSharedPreferences("remote-network",0);
        String name=prefs.getString("name",null);if(name==null){name="workbench-phone-"+UUID.randomUUID().toString().substring(0,8);if(!prefs.edit().putString("name",name).commit())throw new Exception("Could not save this device’s name");}
        Netcore.start(new File(context.getFilesDir(),"remote-network").getAbsolutePath(),name,"");started=true;
    }
    static void enable(Context context)throws Exception{if(!context.getSharedPreferences("remote-network",0).edit().putBoolean("enabled",true).commit())throw new Exception("Could not save remote connection settings");start(context);}
    static synchronized void disable(Context context)throws Exception{if(started)Netcore.stop();started=false;if(!context.getSharedPreferences("remote-network",0).edit().putBoolean("enabled",false).commit())throw new Exception("Connection stopped, but its disabled setting could not be saved");}
    static JSONObject status(Context context)throws Exception{if(!enabled(context))return new JSONObject().put("enabled",false);start(context);return new JSONObject(Netcore.status());}
    static void login(Context context)throws Exception{start(context);Netcore.login();}
    static void logout(Context context)throws Exception{start(context);Netcore.logout();}
    static JSONObject request(Context context,JSONObject descriptor,String endpoint,JSONObject body)throws Exception{
        start(context);JSONObject request=new JSONObject().put("host",descriptor.getString("host")).put("port",descriptor.getInt("port")).put("cert",descriptor.getString("cert")).put("token",descriptor.optString("token","")).put("endpoint",endpoint);
        if(body!=null)request.put("body",body);
        return new JSONObject(Netcore.request(request.toString()));
    }
}
