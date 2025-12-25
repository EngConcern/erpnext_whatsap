// Copyright (c) 2025, donnc and contributors
// For license information, please see license.txt

frappe.ui.form.on("Bot Flow", {
  refresh: function (frm) {
    // Add "Open Bot Studio" button
   /* frm.add_custom_button(__("Open Bot Studio"), function () {
      // Pass the flow name as a parameter to the studio
      const flowName = encodeURIComponent(frm.doc.name);
      window.open(`/bot/studio?flow=${flowName}`, "_blank");
    });
    */

    // Add "Duplicate Flow" button
    if (!frm.is_new()) {
      frm.add_custom_button(__("Duplicate Flow"), function () {
        frappe.prompt(
          {
            label: "New Flow Name",
            fieldname: "new_flow_name",
            fieldtype: "Data",
            reqd: 1,
          },
          function (values) {
            frappe.call({
              method: "frappe_pywce.frappe_pywce.doctype.bot_flow.bot_flow.duplicate_flow",
              args: {
                source_name: frm.doc.name,
                new_name: values.new_flow_name,
              },
              callback: function (r) {
                if (r.message) {
                  frappe.set_route("Form", "Bot Flow", r.message);
                  frappe.show_alert({
                    message: __("Flow duplicated successfully"),
                    indicator: "green",
                  });
                }
              },
            });
          },
          __("Duplicate Flow"),
          __("Create")
        );
      });
    }

    // Add "Export Flow" button
    if (!frm.is_new()) {
      frm.add_custom_button(__("Export Flow"), function () {
        frappe.call({
          method: "frappe_pywce.frappe_pywce.doctype.bot_flow.bot_flow.export_flow",
          args: {
            flow_name: frm.doc.name,
          },
          callback: function (r) {
            if (r.message) {
              const dataStr = JSON.stringify(r.message, null, 2);
              const dataUri =
                "data:application/json;charset=utf-8," +
                encodeURIComponent(dataStr);
              const exportFileDefaultName = `${frm.doc.name}_flow.json`;

              const linkElement = document.createElement("a");
              linkElement.setAttribute("href", dataUri);
              linkElement.setAttribute("download", exportFileDefaultName);
              linkElement.click();

              frappe.show_alert({
                message: __("Flow exported successfully"),
                indicator: "green",
              });
            }
          },
        });
      });
    }

    // Set metadata fields
    if (frm.is_new() && !frm.doc.created_by) {
      frm.set_value("created_by", frappe.session.user);
    }
  },

  before_save: function (frm) {
    // Update last modified timestamp before saving
    frm.set_value("last_modified", frappe.datetime.now_datetime());
  },
});

// List view customization
frappe.listview_settings["Bot Flow"] = {
  add_fields: ["is_active", "flow_type"],
  get_indicator: function (doc) {
    if (doc.is_active) {
      return [__("Active"), "green", "is_active,=,1"];
    } else {
      return [__("Inactive"), "red", "is_active,=,0"];
    }
  },
  button: {
    show: function (doc) {
      return doc.name;
    },
    get_label: function () {
      return __("Open Studio");
    },
    get_description: function (doc) {
      return __("Open {0} in Bot Studio", [doc.name]);
    },
    action: function (doc) {
      const flowName = encodeURIComponent(doc.name);
      window.open(`/bot/studio?flow=${flowName}`, "_blank");
    },
  },
};