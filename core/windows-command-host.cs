// SPDX-License-Identifier: Apache-2.0
// Original Win32 interop. Job assignment is atomic with process creation (Windows 10+).
// This controls process lifetime, not filesystem/network permissions or hostile code.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace OpenAster {
  public static class CommandHost {
    [StructLayout(LayoutKind.Sequential)] struct Security { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
      public int cb; public string reserved, desktop, title;
      public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show, reservedBytes;
      public IntPtr reserved2, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup info; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
      public long processTime, jobTime; public uint flags; public UIntPtr minWorkingSet,maxWorkingSet;
      public uint activeProcesses; public UIntPtr affinity; public uint priority,scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong rOps,wOps,oOps,rBytes,wBytes,oBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
      public BasicLimit basic; public IoCounters io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref ExtendedLimit info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security sa, int size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref Security sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder args, IntPtr processSA, IntPtr threadSA, bool inherit, uint flags, IntPtr env, string cwd, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool ok) { if (!ok) throw new InvalidOperationException("WIN32_" + Marshal.GetLastWin32Error()); }
    static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); handle=IntPtr.Zero; }
    static string ReadText() { string line=Console.ReadLine(); if(line==null || line.Length>100000) throw new InvalidOperationException("INPUT"); return Encoding.UTF8.GetString(Convert.FromBase64String(line)); }
    sealed class Capture {
      public byte[] data; public bool truncated; public bool failed;
      public void Read(IntPtr handle) {
        try {
          using (var stream=new FileStream(new SafeFileHandle(handle,true),FileAccess.Read,8192,false))
          using (var memory=new MemoryStream()) {
            var buffer=new byte[8192]; int count;
            while((count=stream.Read(buffer,0,buffer.Length))>0) { int keep=Math.Min(count,262144-(int)memory.Length); if(keep>0) memory.Write(buffer,0,keep); if(keep<count) truncated=true; }
            data=memory.ToArray();
          }
        } catch { failed=true; data=new byte[0]; }
      }
    }
    public static int Run() {
      IntPtr job=IntPtr.Zero,attrs=IntPtr.Zero,handles=IntPtr.Zero,jobs=IntPtr.Zero;
      IntPtr input=IntPtr.Zero,outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero;
      ProcessInfo process=new ProcessInfo(); bool initialized=false,closed=false; object gate=new object();
      try {
        string shell=ReadText(),cwd=ReadText(),encoded=ReadText();
        // The caller supplies the fixed system shell, never an executable selected by the model.
        if(!Path.IsPathRooted(shell) || !Path.IsPathRooted(cwd) || !System.Text.RegularExpressions.Regex.IsMatch(encoded,@"\A[A-Za-z0-9+/=]+\z")) throw new InvalidOperationException("INPUT");
        job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
        var limit=new ExtendedLimit(); limit.basic.flags=0x2000; // KILL_ON_JOB_CLOSE; breakaway is not enabled.
        Check(SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(limit)));
        var sa=new Security(); sa.length=Marshal.SizeOf(sa); sa.inherit=1;
        input=CreateFile("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero); Check(input!=new IntPtr(-1));
        Check(CreatePipe(out outRead,out outWrite,ref sa,0)); Check(SetHandleInformation(outRead,1,0));
        Check(CreatePipe(out errRead,out errWrite,ref sa,0)); Check(SetHandleInformation(errRead,1,0));
        IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
        attrs=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attrs,2,0,ref size)); initialized=true;
        handles=Marshal.AllocHGlobal(3*IntPtr.Size); Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,outWrite); Marshal.WriteIntPtr(handles,2*IntPtr.Size,errWrite);
        Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new IntPtr(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
        jobs=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs,job);
        // JOB_LIST closes the create/assign crash gap; there is no unowned suspended child.
        Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x2000D),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
        var startup=new StartupEx(); startup.info.cb=Marshal.SizeOf(startup); startup.info.flags=0x100;
        startup.info.input=input; startup.info.output=outWrite; startup.info.error=errWrite; startup.attributes=attrs;
        var args=new StringBuilder("\""+shell+"\" -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand "+encoded);
        Check(CreateProcess(shell,args,IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,cwd,ref startup,out process));
        Close(ref input); Close(ref outWrite); Close(ref errWrite);
        Console.WriteLine("READY"); Console.Out.Flush();
        // Do not execute the approved command until durable start/audit acknowledgement.
        if(Console.ReadLine()!="GO") return 2;
        var output=new Capture(); var error=new Capture();
        IntPtr outOwned=outRead,errOwned=errRead; outRead=errRead=IntPtr.Zero;
        var readerOut=new Thread(()=>output.Read(outOwned)); var readerErr=new Thread(()=>error.Read(errOwned));
        readerOut.IsBackground=readerErr.IsBackground=true; readerOut.Start(); readerErr.Start();
        // EOF (parent died), cancellation, or timeout kills this job, never a process selected by PID.
        IntPtr ownedJob=job;
        var lifeline=new Thread(()=>{try { Console.ReadLine(); } catch {} lock(gate) { if(!closed) TerminateJobObject(ownedJob,130); }});
        lifeline.IsBackground=true; lifeline.Start();
        Check(ResumeThread(process.thread)!=0xffffffff); Close(ref process.thread);
        Check(WaitForSingleObject(process.process,0xffffffff)==0); uint exit; Check(GetExitCodeProcess(process.process,out exit));
        // A command is bounded: background descendants must not survive its shell's exit.
        Check(TerminateJobObject(job,130));
        Check(readerOut.Join(5000) && readerErr.Join(5000) && !output.failed && !error.failed);
        Console.WriteLine("RESULT\t"+unchecked((int)exit)+"\t"+(output.truncated||error.truncated?"1":"0")+"\t"+Convert.ToBase64String(output.data)+"\t"+Convert.ToBase64String(error.data));
        Console.Out.Flush(); return 0;
      } catch { Console.WriteLine("HOST_ERROR"); Console.Out.Flush(); return 1; }
      finally {
        lock(gate) { closed=true; if(job!=IntPtr.Zero) TerminateJobObject(job,130); Close(ref job); }
        Close(ref process.thread); Close(ref process.process);
        Close(ref input); Close(ref outRead); Close(ref outWrite); Close(ref errRead); Close(ref errWrite);
        if(initialized) DeleteProcThreadAttributeList(attrs);
        if(attrs!=IntPtr.Zero) Marshal.FreeHGlobal(attrs);
        if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
        if(jobs!=IntPtr.Zero) Marshal.FreeHGlobal(jobs);
      }
    }
  }
}
