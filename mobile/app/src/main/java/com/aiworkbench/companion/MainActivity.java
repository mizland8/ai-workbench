package com.aiworkbench.companion;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.*;
import org.json.*;
import java.util.*;
import java.util.concurrent.*;

/** Offline-first native companion. No remote delivery exists until a PC is paired. */
@android.annotation.SuppressLint("SetTextI18n") // English preview UI; localization is not yet provided.
public class MainActivity extends Activity {
    private final int BG=Color.rgb(16,20,20), CARD=Color.rgb(26,32,31), LINE=Color.rgb(49,60,55),
        INK=Color.rgb(239,245,239), MUTED=Color.rgb(156,172,164), GREEN=Color.rgb(165,243,194);
    private SharedPreferences prefs;
    private JSONArray pcs=new JSONArray(), drafts=new JSONArray();
    private LinearLayout root, content;
    private ScrollView pageScroll;
    private String renderedPage;
    private final Map<String,Integer> scrollPositions=new HashMap<>();
    private TextView locationLabel;
    private final Map<String,String> computerHosts=new HashMap<>();
    private static final String INDIVIDUAL="__individual__";
    private String tab="Computers";
    private boolean draftFilter=false;
    private LinkClient links;
    private final ExecutorService network=Executors.newCachedThreadPool();
    private final Map<String,JSONObject> snapshots=new HashMap<>();
    private final Map<String,String> connectionStates=new HashMap<>();
    private volatile int watchGeneration=0;
    private String selectedPc=null,selectedChat=null,selectedProject=null;
    private TextView liveOutput,liveStatus,liveReceipt,liveSend,liveQueueState,discardQueued,liveTitle;
    private String lastMessageId;
    private EditText messageInput;
    private JSONObject retryMessage;
    private int dialogs=0;
    @Override protected void onStart(){super.onStart();startWatches();}
    @Override protected void onStop(){saveComposerDraft();watchGeneration++;super.onStop();}
    @Override protected void onDestroy(){network.shutdownNow();super.onDestroy();}
    private void startWatches(){
        int generation=++watchGeneration;
        for(int i=0;i<pcs.length();i++){
            String id=pcs.optJSONObject(i).optString("id");if(!links.linked(id))continue;
            network.execute(()->{Long revision=null;
                while(generation==watchGeneration&&!Thread.currentThread().isInterrupted()){
                    try{JSONObject descriptor=links.load(id);if(descriptor==null)return;
                        JSONObject response=links.request(descriptor,revision==null?"snapshot":"snapshot?since="+revision,null);revision=response.getLong("revision");JSONObject snapshot=response.optJSONObject("snapshot");
                        runOnUiThread(()->{if(generation!=watchGeneration)return;if(snapshot!=null)snapshots.put(id,snapshot);connectionStates.put(id,"Connected");
                            if(selectedChat!=null){refreshLiveChat();}else if(dialogs==0){render();}});
                    }catch(Exception e){runOnUiThread(()->{if(generation!=watchGeneration)return;connectionStates.put(id,"Offline · "+e.getMessage());if(selectedChat!=null)refreshLiveChat();else if(dialogs==0)render();});
                        try{Thread.sleep(5000);}catch(InterruptedException stop){Thread.currentThread().interrupt();return;}
                    }
                }
            });
        }
    }
    private String connection(String id){return connectionStates.getOrDefault(id,links.linked(id)?"Connecting…":"Not linked");}
    private int linkedCount(){int count=0;for(int i=0;i<pcs.length();i++)if(links.linked(pcs.optJSONObject(i).optString("id")))count++;return count;}


    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        links=new LinkClient(this);
        prefs=getSharedPreferences("workbench", MODE_PRIVATE);
        try { pcs=new JSONArray(prefs.getString("pcs","[]")); drafts=new JSONArray(prefs.getString("drafts","[]")); }
        catch(JSONException e) { Toast.makeText(this,"Saved data could not be read.",Toast.LENGTH_LONG).show(); }
        if(!prefs.contains("pcs"))save();
        // Remove only unused preview slots; preserve linked computers, custom entries and drafts.
        if(!prefs.getBoolean("hierarchy-ui",false)){
            for(int i=pcs.length()-1;i>=0;i--){JSONObject pc=pcs.optJSONObject(i);boolean used=false;
                for(int j=0;j<drafts.length();j++)if(pc.optString("id").equals(drafts.optJSONObject(j).optString("pcId")))used=true;
                if(pc.optString("name").matches("PC [1-3]")&&pc.optString("note").isEmpty()&&!links.linked(pc.optString("id"))&&!used)pcs.remove(i);
            }save();prefs.edit().putBoolean("hierarchy-ui",true).apply();
        }
        for(int i=0;i<pcs.length();i++)try{JSONObject pc=pcs.optJSONObject(i),descriptor=links.load(pc.optString("id"));if(descriptor!=null)computerHosts.put(pc.optString("id"),descriptor.optString("host"));}catch(Exception ignored){}
        if(android.os.Build.VERSION.SDK_INT>=33)getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,this::goBack);
        if(state!=null) {tab=state.getString("tab","Computers"); draftFilter=state.getBoolean("draftFilter",false);selectedPc=state.getString("selectedPc");selectedChat=state.getString("selectedChat");selectedProject=state.getString("selectedProject");}
        render();
    }
    @Override protected void onSaveInstanceState(Bundle out) {
        saveComposerDraft();super.onSaveInstanceState(out); out.putString("tab",tab); out.putBoolean("draftFilter",draftFilter);out.putString("selectedPc",selectedPc);out.putString("selectedChat",selectedChat);out.putString("selectedProject",selectedProject);
    }
    private JSONObject object(String... pairs) {
        JSONObject o=new JSONObject();
        for(int i=0;i<pairs.length;i+=2) try{o.put(pairs[i],pairs[i+1]);}catch(JSONException ignored){}
        return o;
    }
    private void save(){ prefs.edit().putString("pcs",pcs.toString()).putString("drafts",drafts.toString()).apply(); }
    private int dp(float n){return (int)(n*getResources().getDisplayMetrics().density+.5f);}
    private GradientDrawable shape(int color,int stroke,int radius){
        GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));
        if(stroke!=0)d.setStroke(dp(1),stroke);return d;
    }
    private TextView text(String value,int size,int color,boolean bold){
        TextView t=new TextView(this);t.setText(value);t.setTextSize(size);t.setTextColor(color);
        t.setFontFeatureSettings("kern");t.setLineSpacing(dp(3),1);
        if(bold)t.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));return t;
    }
    private LinearLayout vertical(){LinearLayout l=new LinearLayout(this);l.setOrientation(LinearLayout.VERTICAL);return l;}
    private void space(LinearLayout p,int h){View v=new View(this);p.addView(v,new LinearLayout.LayoutParams(1,dp(h)));}
    private LinearLayout card(){
        LinearLayout c=vertical();c.setPadding(dp(20),dp(20),dp(20),dp(20));c.setBackground(shape(CARD,LINE,20));
        LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.bottomMargin=dp(12);content.addView(c,lp);return c;
    }
    private TextView action(LinearLayout parent,String label,boolean primary,Runnable click){
        TextView b=text(label,14,primary?BG:GREEN,true);b.setGravity(Gravity.CENTER);
        b.setMinHeight(dp(48));b.setPadding(dp(14),dp(14),dp(14),dp(14));b.setBackground(shape(primary?GREEN:CARD,primary?0:LINE,12));
        LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.topMargin=dp(12);parent.addView(b,lp);
        b.setOnClickListener(v->click.run());return b;
    }
    private void heading(String eyebrow,String title,String desc){
        content.addView(text(eyebrow.toUpperCase(Locale.ROOT),11,GREEN,true));space(content,8);
        content.addView(text(title,32,INK,true));space(content,8);content.addView(text(desc,14,MUTED,false));space(content,24);
    }
    private void section(String name){space(content,10);content.addView(text(name,18,INK,true));space(content,12);}
    private String pcName(String id){
        for(int i=0;i<pcs.length();i++){JSONObject pc=pcs.optJSONObject(i);if(!pc.optString("id").equals(id))continue;
            String alias=pc.optString("name");if(!alias.isEmpty()&&!alias.matches("PC [1-3]"))return alias;
            JSONObject snapshot=snapshots.get(id),device=snapshot==null?null:snapshot.optJSONObject("device");
            if(device!=null&&!device.optString("name").isEmpty())return device.optString("name");
            String host=computerHosts.get(id);return host==null?(alias.isEmpty()?"New computer":alias):"Computer at "+host;
        }return "Removed computer";
    }
    private String projectName(){
        if(INDIVIDUAL.equals(selectedProject))return "Individual chats";
        JSONObject snapshot=snapshots.get(selectedPc);JSONArray projects=snapshot==null?null:snapshot.optJSONArray("projects");
        if(projects!=null)for(int i=0;i<projects.length();i++)if(projects.optJSONObject(i).optString("id").equals(selectedProject))return projects.optJSONObject(i).optString("name");
        return "Projects";
    }
    private String location(){return selectedPc==null?"Computers":pcName(selectedPc)+(selectedProject==null?"":"  ›  "+projectName());}
    private void saveComposerDraft(){if(messageInput!=null&&selectedChat!=null&&prefs!=null)prefs.edit().putString("input."+selectedPc+"."+selectedChat,messageInput.getText().toString()).apply();}
    private void openComputer(String id){saveComposerDraft();selectedPc=id;selectedProject=null;selectedChat=null;draftFilter=false;retryMessage=null;tab="Projects";render();}
    private void openProject(String id){saveComposerDraft();selectedProject=id;selectedChat=null;draftFilter=false;retryMessage=null;tab="Chats";render();}
    private void openChat(String id){saveComposerDraft();selectedChat=id;retryMessage=null;lastMessageId=null;render();}
    private void goBack(){
        saveComposerDraft();
        if(draftFilter){draftFilter=false;selectedPc=null;selectedProject=null;selectedChat=null;}
        else if(selectedChat!=null){selectedChat=null;retryMessage=null;}
        else if(selectedProject!=null){selectedProject=null;}
        else if(selectedPc!=null){selectedPc=null;}
        else{moveTaskToBack(true);return;}
        render();
    }
    @SuppressWarnings("deprecation") @Override public void onBackPressed(){goBack();}
    private String backLabel(){return selectedChat!=null?"Back to chats":selectedProject!=null?"Back to projects":"Back to computers";}
    private void render(){
        if(pageScroll!=null&&renderedPage!=null)scrollPositions.put(renderedPage,pageScroll.getScrollY());
        renderedPage=(draftFilter?"drafts":String.valueOf(selectedPc)+"/"+selectedProject+"/"+selectedChat);
        messageInput=null;liveTitle=null;liveOutput=null;liveStatus=null;liveReceipt=null;liveSend=null;liveQueueState=null;discardQueued=null;
        root=vertical();root.setBackgroundColor(BG);setContentView(root);
        root.setOnApplyWindowInsetsListener((v,insets)->{
            android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout()|WindowInsets.Type.ime());
            v.setPadding(bars.left,bars.top,bars.right,bars.bottom);return insets;
        });root.requestApplyInsets();
        LinearLayout top=new LinearLayout(this);top.setGravity(Gravity.CENTER_VERTICAL);top.setPadding(dp(8),dp(6),dp(8),dp(6));
        if(selectedPc!=null||draftFilter){TextView back=text("‹",30,GREEN,true);back.setGravity(Gravity.CENTER);back.setContentDescription(backLabel());top.addView(back,new LinearLayout.LayoutParams(dp(48),dp(48)));back.setOnClickListener(v->goBack());}
        LinearLayout title=vertical();title.setPadding(dp(8),0,dp(8),0);title.addView(text("WORKBENCH",10,MUTED,true));
        locationLabel=text(draftFilter?"Saved drafts":location(),15,INK,true);locationLabel.setMaxLines(2);locationLabel.setEllipsize(android.text.TextUtils.TruncateAt.END);title.addView(locationLabel);
        top.addView(title,new LinearLayout.LayoutParams(0,-2,1));
        TextView menu=text("⋯",24,GREEN,true);menu.setGravity(Gravity.CENTER);menu.setContentDescription("More options");top.addView(menu,new LinearLayout.LayoutParams(dp(48),dp(48)));
        menu.setOnClickListener(v->new AlertDialog.Builder(this).setTitle("Workbench").setItems(new String[]{"Saved drafts","Remote connection settings","About"},(d,which)->{if(which==0){saveComposerDraft();draftFilter=true;selectedChat=null;render();}else if(which==1)remoteSettings();else about();}).show());root.addView(top);
        ScrollView scroll=new ScrollView(this);pageScroll=scroll;scroll.setFillViewport(true);scroll.setClipToPadding(false);
        content=vertical();content.setPadding(dp(18),dp(12),dp(18),dp(18));scroll.addView(content);
        root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        if(draftFilter)draftsScreen();else if(selectedChat!=null)liveChat();else if(selectedPc==null)computers();else if(selectedProject==null)projects();else chats();
        final int savedScroll=scrollPositions.getOrDefault(renderedPage,0);scroll.post(()->scroll.scrollTo(0,savedScroll));
    }
    private void computers(){
        heading("Choose a computer","Computers","Open a computer to see its projects, then choose an AI chat.");
        for(int i=0;i<pcs.length();i++){
            JSONObject pc=pcs.optJSONObject(i);String id=pc.optString("id");JSONObject snapshot=snapshots.get(id),device=snapshot==null?null:snapshot.optJSONObject("device");
            LinearLayout c=card();c.addView(text(pcName(id),22,INK,true));space(c,8);
            String platform=device==null?"":device.optString("platform"),host=computerHosts.getOrDefault(id,"");
            if("macos".equals(platform))platform="macOS";else if("windows".equals(platform))platform="Windows";else if("linux".equals(platform))platform="Linux";
            if(!platform.isEmpty()||!host.isEmpty())c.addView(text((platform.isEmpty()?"":platform+" · ")+host,12,MUTED,false));
            c.addView(text(connection(id),13,"Connected".equals(connection(id))?GREEN:MUTED,true));
            if(!pc.optString("note").isEmpty()){space(c,6);c.addView(text(pc.optString("note"),14,MUTED,false));}
            if(snapshot!=null)c.addView(text(snapshot.optJSONArray("projects").length()+" projects · "+snapshot.optJSONArray("chats").length()+" chats",13,MUTED,false));
            if(links.linked(id))action(c,"Open projects",true,()->openComputer(id));else action(c,"Link computer",true,()->pairPc(pc));
            action(c,"Manage "+pcName(id),false,()->new AlertDialog.Builder(this).setTitle(pcName(id)).setItems(new String[]{"Rename or edit computer","Update pairing code","Unlink on this phone"},(d,which)->{
                if(which==0)editPc(pc);else if(which==1)pairPc(pc);else new AlertDialog.Builder(this).setTitle("Unlink "+pcName(id)+"?").setMessage("This phone will stop connecting. You can also revoke its credential in Workbench on that computer.").setNegativeButton("Cancel",null).setPositiveButton("Unlink",(x,y)->{links.forget(id);snapshots.remove(id);connectionStates.remove(id);startWatches();render();}).show();
            }).show());
        }
        if(pcs.length()==0){LinearLayout c=card();c.addView(text("Add your first computer",21,INK,true));space(c,8);c.addView(text("Give each machine a clear name, such as Home PC or MacBook, then paste its Workbench pairing code.",14,MUTED,false));}
        action(content,"+ Add computer",true,()->editPc(null));
        action(content,"Remote connection settings",false,()->remoteSettings());
    }
    private JSONArray currentChats(){JSONObject snapshot=snapshots.get(selectedPc);return snapshot==null?new JSONArray():snapshot.optJSONArray("chats")==null?new JSONArray():snapshot.optJSONArray("chats");}
    private boolean inProject(JSONObject chat,String project){return INDIVIDUAL.equals(project)?chat.isNull("projectId")||chat.optString("projectId").isEmpty():project.equals(chat.optString("projectId"));}
    private void projects(){
        heading(pcName(selectedPc),"Projects",connection(selectedPc)+" · Choose a project on this computer.");
        JSONObject snapshot=snapshots.get(selectedPc);JSONArray projects=snapshot==null?new JSONArray():snapshot.optJSONArray("projects");JSONArray chats=currentChats();
        if(projects==null)projects=new JSONArray();
        for(int i=0;i<projects.length();i++){
            JSONObject project=projects.optJSONObject(i);String id=project.optString("id");int count=0;for(int j=0;j<chats.length();j++)if(inProject(chats.optJSONObject(j),id))count++;
            LinearLayout row=card();row.addView(text(project.optString("name"),21,INK,true));space(row,6);
            if(!project.optString("path").isEmpty())row.addView(text(project.optString("path"),12,MUTED,false));
            row.addView(text(count+" AI chat(s)",13,MUTED,false));action(row,"Open chats",true,()->openProject(id));
        }
        int individual=0;for(int i=0;i<chats.length();i++)if(inProject(chats.optJSONObject(i),INDIVIDUAL))individual++;
        if(individual>0){LinearLayout c=card();c.addView(text("Individual chats",21,INK,true));space(c,6);c.addView(text(individual+" chats without a project on "+pcName(selectedPc),13,MUTED,false));action(c,"Open individual chats",false,()->openProject(INDIVIDUAL));}
        if(projects.length()==0&&individual==0){LinearLayout c=card();c.addView(text(snapshot==null?"Waiting for this computer":"No projects on this computer",20,INK,true));space(c,8);c.addView(text("Keep Workbench open on "+pcName(selectedPc)+". "+connection(selectedPc),14,MUTED,false));}
    }
    private void chats(){
        heading(pcName(selectedPc)+" › "+projectName(),"Chats","Choose a conversation in this project.");
        JSONArray chats=currentChats();int count=0;
        for(int i=0;i<chats.length();i++){
            JSONObject chat=chats.optJSONObject(i);if(!inProject(chat,selectedProject))continue;count++;
            LinearLayout row=card();row.addView(text(chat.optString("name"),21,INK,true));space(row,6);
            row.addView(text(chat.optString("tool").toUpperCase(Locale.ROOT)+" · "+chat.optString("status")+" · "+chat.optString("id").substring(0,Math.min(8,chat.optString("id").length())),12,MUTED,false));
            action(row,"Open conversation",true,()->openChat(chat.optString("id")));
        }
        if(count==0){LinearLayout c=card();c.addView(text("No chats in this project",20,INK,true));space(c,8);c.addView(text("Start an AI chat in this project in Workbench on "+pcName(selectedPc)+".",14,MUTED,false));}
    }
    private void draftsScreen(){
        heading("Saved on this phone","Drafts","These drafts have not been sent to an AI.");
        if(drafts.length()==0){LinearLayout c=card();c.addView(text("No saved drafts",21,INK,true));}
        for(int i=drafts.length()-1;i>=0;i--){JSONObject d=drafts.optJSONObject(i);LinearLayout c=card();c.addView(text(pcName(d.optString("pcId"))+" › "+d.optString("project","Individual chats"),13,GREEN,true));space(c,6);c.addView(text(d.optString("chat","Unassigned chat"),20,INK,true));TextView body=text(d.optString("body"),14,MUTED,false);body.setMaxLines(4);c.addView(body);action(c,"Edit draft",false,()->editDraft(d));}
        action(content,"+ Write a draft",true,()->editDraft(null));
    }
    private EditText input(LinearLayout box,String label,String value,boolean multiline){
        space(box,12);box.addView(text(label,12,MUTED,true));EditText e=new EditText(this);e.setText(value);e.setTextColor(INK);e.setTextSize(16);e.setPadding(dp(12),dp(10),dp(12),dp(10));e.setBackground(shape(BG,LINE,8));
        e.setInputType(InputType.TYPE_CLASS_TEXT | (multiline?InputType.TYPE_TEXT_FLAG_MULTI_LINE|InputType.TYPE_TEXT_FLAG_CAP_SENTENCES:InputType.TYPE_TEXT_FLAG_CAP_SENTENCES));
        if(multiline){e.setMinLines(4);e.setGravity(Gravity.TOP);}else e.setSingleLine(true);
        LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.topMargin=dp(6);box.addView(e,lp);return e;
    }
    private LinearLayout dialogBox(){LinearLayout box=vertical();box.setPadding(dp(22),dp(8),dp(22),dp(8));return box;}
    private void editPc(JSONObject existing){
        LinearLayout box=dialogBox();EditText name=input(box,"Computer name",existing==null?"":existing.optString("name"),false);
        EditText note=input(box,"Note (optional)",existing==null?"":existing.optString("note"),true);
        AlertDialog.Builder b=new AlertDialog.Builder(this).setTitle(existing==null?"Add computer":"Edit computer").setView(box).setNegativeButton("Cancel",null).setPositiveButton("Save",null);
        if(existing!=null)b.setNeutralButton("Remove",(a,w)->confirmRemovePc(existing));
        AlertDialog dialog=b.create();dialog.setOnShowListener(a->dialog.getButton(-1).setOnClickListener(v->{
            String n=name.getText().toString().trim();if(n.isEmpty()){name.setError("Enter a computer name");return;}
            JSONObject pc=existing==null?object("id",UUID.randomUUID().toString()):existing;
            try{pc.put("name",n);pc.put("note",note.getText().toString().trim());}catch(JSONException ignored){}
            if(existing==null)pcs.put(pc);save();dialog.dismiss();render();
        }));dialog.show();
    }
    private void confirmRemovePc(JSONObject pc){
        new AlertDialog.Builder(this).setTitle("Remove "+pc.optString("name")+"?").setMessage("Saved drafts will be kept. This removes only this phone’s computer entry.")
        .setNegativeButton("Cancel",null).setPositiveButton("Remove",(a,w)->{
            for(int i=pcs.length()-1;i>=0;i--)if(pcs.optJSONObject(i).optString("id").equals(pc.optString("id")))pcs.remove(i);
            String removed=pc.optString("id");links.forget(removed);snapshots.remove(removed);connectionStates.remove(removed);startWatches();
            save();render();
        }).show();
    }
    private void editDraft(JSONObject existing){
        if(pcs.length()==0){new AlertDialog.Builder(this).setTitle("Add a computer first").setMessage("Save a computer name so your draft has a destination.").setPositiveButton("Add computer",(a,w)->editPc(null)).setNegativeButton("Cancel",null).show();return;}
        LinearLayout box=dialogBox();box.addView(text("Saved on this phone · drafts are never sent automatically",12,GREEN,false));space(box,12);
        Spinner computer=new Spinner(this);ArrayList<String> names=new ArrayList<>();int selected=0;
        for(int i=0;i<pcs.length();i++){JSONObject p=pcs.optJSONObject(i);names.add(p.optString("name"));if(existing!=null&&p.optString("id").equals(existing.optString("pcId")))selected=i;}
        computer.setAdapter(new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,names));computer.setSelection(selected);box.addView(computer);
        EditText project=input(box,"Project (optional)",existing==null?"":existing.optString("project"),false);
        EditText chat=input(box,"Chat / AI name",existing==null?"":existing.optString("chat"),false);
        EditText body=input(box,"Instructions",existing==null?"":existing.optString("body"),true);
        ScrollView scroll=new ScrollView(this);scroll.addView(box);
        AlertDialog.Builder b=new AlertDialog.Builder(this).setTitle(existing==null?"New draft":"Edit draft").setView(scroll).setNegativeButton("Cancel",null).setPositiveButton("Save draft",null);
        if(existing!=null)b.setNeutralButton("Delete",(a,w)->new AlertDialog.Builder(this).setTitle("Delete draft?").setMessage("This cannot be undone.").setNegativeButton("Cancel",null).setPositiveButton("Delete",(x,y)->{
            for(int i=drafts.length()-1;i>=0;i--)if(drafts.optJSONObject(i).optString("id").equals(existing.optString("id")))drafts.remove(i);save();render();
        }).show());
        AlertDialog dialog=b.create();dialog.setOnShowListener(a->dialog.getButton(-1).setOnClickListener(v->{
            String message=body.getText().toString().trim(),recipient=chat.getText().toString().trim();
            if(recipient.isEmpty()){chat.setError("Enter the chat or AI name");return;}if(message.isEmpty()){body.setError("Write your instructions");return;}
            JSONObject d=existing==null?object("id",UUID.randomUUID().toString()):existing;
            try{d.put("pcId",pcs.optJSONObject(computer.getSelectedItemPosition()).optString("id"));d.put("project",project.getText().toString().trim());d.put("chat",recipient);d.put("body",message);d.put("updated",System.currentTimeMillis());}catch(JSONException ignored){}
            if(existing==null)drafts.put(d);save();dialog.dismiss();tab="Chats";draftFilter=true;render();Toast.makeText(this,"Draft saved · not sent",Toast.LENGTH_SHORT).show();
        }));dialog.show();
    }
    private void pairPc(JSONObject pc){
        LinearLayout box=dialogBox();box.addView(text("For local Wi-Fi: connect the phone and PC to the same network. On the PC, open Computers → Enable linking → Create pairing code, then paste the complete code below. No Tailscale account is needed. If the connection times out, click Allow Wi-Fi connections on the PC. For access away from home, use a remote pairing code instead.",14,MUTED,false));
        EditText code=input(box,"Pairing code","",true);code.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE|InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("Link "+pc.optString("name")).setView(box).setNegativeButton("Cancel",null).setPositiveButton("Pair",null).create();
        dialogs++;dialog.setOnDismissListener(d->dialogs--);
        dialog.setOnShowListener(d->dialog.getButton(-1).setOnClickListener(v->{String value=code.getText().toString().trim();dialog.getButton(-1).setEnabled(false);
            network.execute(()->{try{JSONObject descriptor=links.pair(value,"Pixel / Workbench Companion");links.save(pc.optString("id"),descriptor);runOnUiThread(()->{computerHosts.put(pc.optString("id"),descriptor.optString("host"));dialog.dismiss();startWatches();render();});}
            catch(Exception e){runOnUiThread(()->{code.setError(e.getMessage());dialog.getButton(-1).setEnabled(true);});}});
        }));dialog.show();
    }
    private JSONObject currentChat(){JSONObject snapshot=snapshots.get(selectedPc);JSONArray chats=snapshot==null?null:snapshot.optJSONArray("chats");if(chats!=null)for(int i=0;i<chats.length();i++)if(chats.optJSONObject(i).optString("id").equals(selectedChat))return chats.optJSONObject(i);return null;}
    private void refreshLiveChat(){
        if(liveOutput==null)return;JSONObject chat=currentChat();
        if(chat!=null&&selectedProject==null)selectedProject=chat.isNull("projectId")?INDIVIDUAL:chat.optString("projectId",INDIVIDUAL);
        if(locationLabel!=null)locationLabel.setText(location());if(liveTitle!=null)liveTitle.setText(chat==null?"Conversation":chat.optString("tool").toUpperCase(Locale.ROOT)+" · "+chat.optString("name"));liveOutput.setText(chat==null?"Waiting for chat output…":chat.optString("output","No output yet"));
        JSONObject prompt=chat==null?null:chat.optJSONObject("replyPrompt");
        if(liveStatus!=null)liveStatus.setText(connection(selectedPc)+(prompt!=null?" · Waiting for your reply":chat==null?"":" · "+chat.optString("status")));
        if(liveSend!=null){liveSend.setText(prompt==null?"Send work":"Send reply");liveSend.setTag(prompt==null?"":prompt.optString("id"));}
        JSONObject snapshot=snapshots.get(selectedPc);JSONArray receipts=snapshot==null?null:snapshot.optJSONArray("receipts");
        int queued=0;String reason="";
        if(receipts!=null)for(int i=0;i<receipts.length();i++){JSONObject r=receipts.optJSONObject(i);if(selectedChat.equals(r.optString("chatId"))&&"queued".equals(r.optString("status"))){queued++;reason=r.optString("reason");}}
        if(liveQueueState!=null)liveQueueState.setText(queued>0?queued+" work message(s) queued. "+reason:prompt!=null?"Read the question above, enter your answer, then tap Send reply. A reply is sent once to this question only.":"Messages wait while the AI is busy or needs your approval.");
        if(discardQueued!=null)discardQueued.setVisibility(queued>0?View.VISIBLE:View.GONE);
        if(receipts!=null&&liveReceipt!=null&&lastMessageId!=null)for(int i=0;i<receipts.length();i++){JSONObject r=receipts.optJSONObject(i);if(lastMessageId.equals(r.optString("id"))&&selectedChat.equals(r.optString("chatId")))liveReceipt.setText(("reply".equals(r.optString("kind"))?"Reply ":"Work ")+r.optString("status")+(r.has("error")?" · "+r.optString("error"):""));}
    }
    private void liveChat(){
        JSONObject chat=currentChat();liveTitle=text(chat==null?"Conversation":chat.optString("tool").toUpperCase(Locale.ROOT)+" · "+chat.optString("name"),22,INK,true);content.addView(liveTitle);space(content,6);
        liveStatus=text(connection(selectedPc),13,GREEN,true);content.addView(liveStatus);space(content,12);
        LinearLayout output=card();liveOutput=text("",12,INK,false);liveOutput.setTypeface(Typeface.MONOSPACE);liveOutput.setTextIsSelectable(true);output.addView(liveOutput);refreshLiveChat();
        String outgoingKey="outgoing."+selectedPc+"."+selectedChat;
        try{String saved=prefs.getString(outgoingKey,null);retryMessage=saved==null?null:new JSONObject(saved);}catch(JSONException e){retryMessage=null;}
        LinearLayout composer=vertical();composer.setPadding(dp(16),dp(8),dp(16),dp(8));composer.setBackground(shape(CARD,LINE,0));root.addView(composer);
        liveQueueState=text("",11,MUTED,false);liveQueueState.setMaxLines(2);composer.addView(liveQueueState);
        LinearLayout row=new LinearLayout(this);row.setGravity(Gravity.CENTER_VERTICAL);composer.addView(row);
        messageInput=new EditText(this);messageInput.setTextColor(INK);messageInput.setHintTextColor(MUTED);messageInput.setHint("Message this chat");messageInput.setContentDescription("Message this chat");messageInput.setTextSize(15);messageInput.setMinLines(1);messageInput.setMaxLines(3);messageInput.setGravity(Gravity.TOP);messageInput.setPadding(dp(10),dp(10),dp(10),dp(10));messageInput.setBackground(shape(BG,LINE,10));messageInput.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE|InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        String inputKey="input."+selectedPc+"."+selectedChat;
        messageInput.setText(retryMessage==null?prefs.getString(inputKey,""):retryMessage.optString("text"));row.addView(messageInput,new LinearLayout.LayoutParams(0,-2,1));
        messageInput.addTextChangedListener(new android.text.TextWatcher(){public void beforeTextChanged(CharSequence t,int st,int count,int after){}public void onTextChanged(CharSequence t,int st,int before,int count){prefs.edit().putString(inputKey,t.toString()).apply();}public void afterTextChanged(android.text.Editable t){}});
        TextView receipt=text("",11,MUTED,false);receipt.setMaxLines(2);composer.addView(receipt);liveReceipt=receipt;
        discardQueued=action(composer,"Discard queued work for this chat",false,()->{
            String pcId=selectedPc,chatId=selectedChat;discardQueued.setEnabled(false);
            network.execute(()->{try{JSONObject result=links.request(links.load(pcId),"message",new JSONObject().put("kind","cancel").put("chatId",chatId));runOnUiThread(()->{receipt.setText("Cancelled "+result.optInt("count")+" queued message(s).");if(discardQueued!=null)discardQueued.setEnabled(true);});}
            catch(Exception e){runOnUiThread(()->{receipt.setText(e.getMessage());if(discardQueued!=null)discardQueued.setEnabled(true);});}});
        });
        TextView send=text("Send work",12,BG,true);send.setGravity(Gravity.CENTER);send.setMaxLines(2);send.setMinHeight(dp(48));send.setPadding(dp(8),dp(8),dp(8),dp(8));send.setBackground(shape(GREEN,0,10));LinearLayout.LayoutParams sendParams=new LinearLayout.LayoutParams(dp(104),-2);sendParams.leftMargin=dp(8);row.addView(send,sendParams);liveSend=send;
        send.setOnClickListener(v->{String message=messageInput.getText().toString().trim();if(message.isEmpty()){messageInput.setError("Write instructions first");return;}
            String promptId=String.valueOf(send.getTag());
            try{if(retryMessage==null||!message.equals(retryMessage.optString("text"))){
                retryMessage=new JSONObject().put("id",UUID.randomUUID().toString()).put("chatId",selectedChat).put("text",message);
                if(!promptId.isEmpty()&&!"null".equals(promptId))retryMessage.put("kind","reply").put("promptId",promptId);
            }}
            catch(JSONException ignored){return;}
            JSONObject request=retryMessage;lastMessageId=request.optString("id");
            if(!prefs.edit().putString(outgoingKey,request.toString()).commit()){receipt.setText("Could not save message retry state; nothing sent.");return;}
            String pcId=selectedPc;final EditText sentInput=messageInput;send.setEnabled(false);receipt.setText("Sending…");
            network.execute(()->{try{JSONObject descriptor=links.load(pcId);if(descriptor==null)throw new Exception("Pair this computer first");JSONObject result=links.request(descriptor,"message",request);
                runOnUiThread(()->{receipt.setText("reply".equals(request.optString("kind"))?"Reply sent to this prompt":"Work "+result.optString("status"));sentInput.setText("");if(pcId.equals(selectedPc)&&request.optString("chatId").equals(selectedChat))retryMessage=null;prefs.edit().remove(outgoingKey).apply();send.setEnabled(true);});}
                catch(Exception e){runOnUiThread(()->{boolean changed="reply".equals(request.optString("kind"))&&e.getMessage()!=null&&e.getMessage().toLowerCase(java.util.Locale.ROOT).contains("prompt changed");
                    if(changed){if(pcId.equals(selectedPc)&&request.optString("chatId").equals(selectedChat))retryMessage=null;prefs.edit().remove(outgoingKey).apply();}
                    receipt.setText(e.getMessage()+(changed?" Read the current question before sending again.":". Retry keeps the same message ID."));send.setEnabled(true);});}
            });
        });
        refreshLiveChat();
    }
    private void remoteSettings(){
        LinearLayout box=dialogBox();box.addView(text("Uses Tailscale’s free personal account for your own devices. Workbench pairing still controls access to projects and chats. Only this app’s traffic uses the connection.",14,MUTED,false));space(box,12);
        TextView status=text("Checking connection…",14,GREEN,false);box.addView(status);
        TextView toggle=action(box,RemoteNetwork.enabled(this)?"Disable built-in remote access":"Enable built-in remote access",true,()->{});
        TextView login=action(box,"Sign in to Tailscale",false,()->{});
        TextView logout=action(box,"Sign out",false,()->{});
        TextView peers=text("",13,MUTED,false);space(box,12);box.addView(peers);
        ScrollView settingsScroll=new ScrollView(this);settingsScroll.addView(box);
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("Remote connection").setView(settingsScroll).setPositiveButton("Done",null).create();
        dialogs++;final boolean[] open={true};final boolean[] checking={false};final JSONObject[] last={null};
        Runnable refresh=()->{
            if(!open[0]||checking[0])return;checking[0]=true;
            network.execute(()->{try{JSONObject info=RemoteNetwork.status(this);runOnUiThread(()->{if(!open[0])return;last[0]=info;
                status.setText(info.optBoolean("enabled")?info.optString("state","Starting")+(info.optString("host").isEmpty()?"":" · "+info.optString("host")):"Built-in remote access is off.");
                toggle.setText(info.optBoolean("enabled")?"Disable built-in remote access":"Enable built-in remote access");
                login.setVisibility(info.optBoolean("enabled")&&!"Running".equals(info.optString("state"))?View.VISIBLE:View.GONE);
                logout.setVisibility("Running".equals(info.optString("state"))?View.VISIBLE:View.GONE);
                JSONArray devices=info.optJSONArray("peers");StringBuilder names=new StringBuilder();if(devices!=null)for(int i=0;i<devices.length();i++){JSONObject device=devices.optJSONObject(i);names.append(device.optString("name")).append(device.optBoolean("online")?" · online":" · offline").append("\n");}peers.setText(names.toString());
            });}catch(Exception e){runOnUiThread(()->{if(open[0])status.setText(e.getMessage());});}finally{runOnUiThread(()->checking[0]=false);}});
        };
        toggle.setOnClickListener(v->{toggle.setEnabled(false);network.execute(()->{try{if(RemoteNetwork.enabled(this))RemoteNetwork.disable(this);else RemoteNetwork.enable(this);runOnUiThread(()->{toggle.setEnabled(true);startWatches();refresh.run();});}catch(Exception e){runOnUiThread(()->{status.setText(e.getMessage());toggle.setEnabled(true);});}});});
        login.setOnClickListener(v->{
            login.setEnabled(false);status.setText("Preparing secure sign-in…");
            network.execute(()->{
                try{
                    JSONObject info=RemoteNetwork.status(this);
                    if("Running".equals(info.optString("state"))){runOnUiThread(()->{status.setText("Already connected");login.setEnabled(true);refresh.run();});return;}
                    String auth=info.optString("authUrl");
                    if(auth.isEmpty()){
                        RemoteNetwork.login(this);
                        for(int attempt=0;attempt<20;attempt++){
                            if(!open[0])return;
                            info=RemoteNetwork.status(this);auth=info.optString("authUrl");if(!auth.isEmpty())break;Thread.sleep(500);
                        }
                    }
                    if(auth.isEmpty())throw new Exception("Sign-in link is not ready. Check your internet connection and try again.");
                    android.net.Uri uri=android.net.Uri.parse(auth);
                    if(!"https".equals(uri.getScheme())||!"login.tailscale.com".equals(uri.getHost()))throw new Exception("Unexpected sign-in address");
                    runOnUiThread(()->{
                        if(!open[0])return;
                        try{startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW,uri));status.setText("Finish sign-in in your browser, then return to Workbench.");}
                        catch(Exception e){status.setText("Could not open the browser: "+e.getMessage());}
                        finally{login.setEnabled(true);}
                    });
                }catch(Exception e){runOnUiThread(()->{if(open[0]){status.setText(e.getMessage());login.setEnabled(true);}});}
            });
        });
        logout.setOnClickListener(v->network.execute(()->{try{RemoteNetwork.logout(this);runOnUiThread(refresh);}catch(Exception e){runOnUiThread(()->status.setText(e.getMessage()));}}));
        android.os.Handler handler=new android.os.Handler(android.os.Looper.getMainLooper());Runnable timer=new Runnable(){public void run(){if(open[0]){refresh.run();handler.postDelayed(this,2000);}}};
        dialog.setOnDismissListener(d->{open[0]=false;handler.removeCallbacks(timer);dialogs--;startWatches();render();});dialog.show();timer.run();
    }
    private void about(){new AlertDialog.Builder(this).setTitle("Workbench Companion 0.4.0").setMessage("Pair with AI Workbench to view projects, chats, and available usage, and send queued messages. Connections use HTTPS pinned to the PC certificate. Pairing credentials are encrypted with Android Keystore.\n\nKeep the PC awake and Workbench open. Local drafts never send automatically. Usage depends on what each AI reports.").setPositiveButton("Got it",null).show();}
}
