cmake_minimum_required(VERSION 3.22.1)
project(launcher_node)
add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)
# Gradle packages this real executable under a .so name so Android extracts it
# into the executable nativeLibraryDir rather than the noexec app data area.
add_executable(node_launcher node_launcher.cpp)
target_include_directories(node_launcher PRIVATE node-include)
target_link_libraries(node_launcher node log)
