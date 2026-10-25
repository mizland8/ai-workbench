package com.aiworkbench.companion;
import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Rect;
import android.view.*;
import android.widget.*;
import org.json.*;
import java.lang.reflect.*;
import java.util.*;

/** Rendered hierarchy and real system Back, using transient fixtures without replacing saved PCs. */
final class NavigationChecks {
    private final Instrumentation test; private MainActivity activity;
    NavigationChecks(Instrumentation test){this.test=test;}
    private Object get(String name)throws Exception{Field f=MainActivity.class.getDeclaredField(name);f.setAccessible(true);return f.get(activity);}
    private void set(String name,Object value)throws Exception{Field f=MainActivity.class.getDeclaredField(name);f.setAccessible(true);f.set(activity,value);}
    private void call(String name,String value)throws Exception{Method m=value==null?MainActivity.class.getDeclaredMethod(name):MainActivity.class.getDeclaredMethod(name,String.class);m.setAccessible(true);if(value==null)m.invoke(activity);else m.invoke(activity,value);}
    private void require(boolean ok,String why){if(!ok)throw new AssertionError(why);}
    private List<TextView> labels(View v){List<TextView> result=new ArrayList<>();if(v instanceof TextView)result.add((TextView)v);if(v instanceof ViewGroup){ViewGroup g=(ViewGroup)v;for(int i=0;i<g.getChildCount();i++)result.addAll(labels(g.getChildAt(i)));}return result;}
    private boolean has(String text){for(TextView v:labels(activity.getWindow().getDecorView()))if(v.getText().toString().equals(text))return true;return false;}
    private void click(String text){for(TextView v:labels(activity.getWindow().getDecorView()))if(v.getText().toString().equals(text)&&v.isClickable()){v.performClick();return;}throw new AssertionError("Missing action: "+text);}
    interface Step{void run()throws Exception;}
    private void ui(Step step){java.util.concurrent.atomic.AtomicReference<Throwable> failure=new java.util.concurrent.atomic.AtomicReference<>();test.runOnMainSync(()->{try{step.run();}catch(Throwable e){failure.set(e);}});test.waitForIdleSync();android.os.SystemClock.sleep(100);if(failure.get()!=null)throw new AssertionError(failure.get());}
    private void back(){test.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);test.waitForIdleSync();android.os.SystemClock.sleep(300);}
    private JSONObject snapshot(String project,String chat,String output)throws Exception{return new JSONObject().put("projects",new JSONArray().put(new JSONObject().put("id",project).put("name","Shared project").put("path","/test/"+project))).put("chats",new JSONArray().put(new JSONObject().put("id",chat).put("name","New chat").put("projectId",project).put("tool","codex").put("status","idle").put("output",output))).put("receipts",new JSONArray());}
    @SuppressWarnings("unchecked") void run()throws Exception{
        activity=(MainActivity)test.startActivitySync(new Intent(test.getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_MULTIPLE_TASK));test.waitForIdleSync();
        try{
            StringBuilder output=new StringBuilder("First computer output\n");for(int i=0;i<300;i++)output.append("terminal output line\n");
            JSONObject first=snapshot("project-one","chat-one",output.toString()),second=snapshot("project-two","chat-two","Second computer output");
            ui(()->{
                set("watchGeneration",((Integer)get("watchGeneration"))+1);
                set("pcs",new JSONArray().put(new JSONObject().put("id","navigation-test-one").put("name","Home PC")).put(new JSONObject().put("id","navigation-test-two").put("name","MacBook")));
                Map<String,JSONObject> snapshots=(Map<String,JSONObject>)get("snapshots");snapshots.clear();snapshots.put("navigation-test-one",first);snapshots.put("navigation-test-two",second);
                LinkClient links=(LinkClient)get("links");links.save("navigation-test-one",new JSONObject().put("host","192.0.2.1"));links.save("navigation-test-two",new JSONObject().put("host","192.0.2.2"));
                set("selectedPc",null);set("selectedProject",null);set("selectedChat",null);set("draftFilter",false);call("render",null);
                require(has("Computers")&&has("Home PC")&&has("MacBook"),"Computers are not identified");call("openComputer","navigation-test-one");require(has("Projects")&&has("Shared project"),"Projects level missing");
                click("Open chats");require(has("Home PC  ›  Shared project"),"Computer/project context missing");click("Open conversation");require(has("Home PC  ›  Shared project"),"Conversation breadcrumb missing");
            });
            ui(()->{Rect r=new Rect();require(((View)get("liveSend")).getGlobalVisibleRect(r)&&r.height()>0,"Composer hidden: size="+((View)get("liveSend")).getWidth()+"x"+((View)get("liveSend")).getHeight()+" focus="+activity.hasWindowFocus());((EditText)get("messageInput")).setText("Unsent note");});
            back();ui(()->{require(get("selectedChat")==null&&"project-one".equals(get("selectedProject")),"Back did not return to chats");require(!activity.isFinishing(),"Back closed app");});
            back();ui(()->require(get("selectedProject")==null&&"navigation-test-one".equals(get("selectedPc")),"Back did not return to selected computer's projects"));
            back();ui(()->{require(get("selectedPc")==null&&has("Computers"),"Back did not return to Computers");call("openComputer","navigation-test-one");click("Open chats");click("Open conversation");require("Unsent note".equals(((EditText)get("messageInput")).getText().toString()),"Unsent draft lost");});
            back();back();back();ui(()->{call("openComputer","navigation-test-two");click("Open chats");click("Open conversation");require(has("Second computer output"),"Wrong computer output");require(((EditText)get("messageInput")).getText().length()==0,"Draft leaked between computers");require(has("MacBook  ›  Shared project"),"Second computer context missing");});
        }finally{ui(()->{((LinkClient)get("links")).forget("navigation-test-one");((LinkClient)get("links")).forget("navigation-test-two");set("selectedChat",null);set("messageInput",null);activity.getSharedPreferences("workbench",0).edit().remove("input.navigation-test-one.chat-one").remove("input.navigation-test-two.chat-two").apply();activity.finishAndRemoveTask();});}
    }
}
