mod automation_file_system;
mod fonts;

use automation_file_system::AutomationFileSystemState;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::Emitter;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_safe_area_insets_css::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_system_fonts::init())
        .manage(AutomationFileSystemState::default())
        .invoke_handler(tauri::generate_handler![
            fonts::load_font_data,
            automation_file_system::automation_open_files,
            automation_file_system::automation_save_file,
            automation_file_system::automation_register_document_directory,
            automation_file_system::automation_read_file,
            automation_file_system::automation_write_file,
            automation_file_system::automation_create_directory,
            automation_file_system::automation_directory_file,
            automation_file_system::automation_revoke_access
        ])
        .setup(|app| {
            let app_menu = SubmenuBuilder::new(app, &app.package_info().name)
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let reload = MenuItemBuilder::new("Reload")
                .id("reload")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;

            let force_reload = MenuItemBuilder::new("Force Reload")
                .id("force-reload")
                .accelerator("CmdOrCtrl+Shift+R")
                .build(app)?;

            #[allow(unused_mut)]
            let mut view_builder = SubmenuBuilder::new(app, "View")
                .item(&reload)
                .item(&force_reload);

            #[cfg(debug_assertions)]
            let devtools = MenuItemBuilder::new("Toggle Developer Tools")
                .id("devtools")
                .accelerator("CmdOrCtrl+Shift+I")
                .build(app)?;

            #[cfg(debug_assertions)]
            {
                view_builder = view_builder.separator().item(&devtools);
            }

            let view_menu = view_builder.build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &edit_menu, &view_menu])
                .build()?;

            app.set_menu(menu)?;

            app.on_menu_event(move |app, event| {
                let id = event.id().0.as_str();
                match id {
                    "reload" | "force-reload" => {
                        if let Some(window) = app.get_webview_window("main") {
                            window.emit("app:reload", ()).ok();
                        }
                    }
                    #[cfg(debug_assertions)]
                    "devtools" => {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_devtools_open() {
                                window.close_devtools();
                            } else {
                                window.open_devtools();
                            }
                        }
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
