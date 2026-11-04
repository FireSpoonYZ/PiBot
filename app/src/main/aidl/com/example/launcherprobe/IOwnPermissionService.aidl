package com.example.launcherprobe;

interface IOwnPermissionService {
    String startShowerServer(String handoffToken) = 3;
    String stopShowerServer() = 4;
    void destroy() = 16777114;
}
