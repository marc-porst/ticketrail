

### Problem definition

When creating projects with claude code or other tools, the process is usually very iterative. You start with a prompt that creates the ground project. Than, piece by piece you add features. Usually these prompts are typed into the claude window and sometimes a description is added to Jira. This is hard to track and does not live within the project. When using the claude build in chat there is also no frontend that gives a good overview. 

### Solution proposal

The solution can be webbased kanban view with different columns. The columns should be in sync with the status of claude. So I would see here following status

* "Backlog" All tasks that should not be touched by claude yet
* "Plan" All tasks that needs to be planned first before implemented
* "User input" All tasks that need a user input
* "Implement" All tasks that should be picked up by claude. The first one has a higher priority than the last one
* "In progress" All tasks claude is currently working on
* "Planned" All tasks claude planned. The plan will be visible in the task and can be changed
* "Done" All tasks that claude has finished. 

### User journey

A user starts a new project. He sets up the claude environment and adds a new skill called "prompt kanban". The user will type /ticketrail-start and in the project folder a new folder is created running a npm server with a react UI that looks very modern. It behaviour like trello and has the following lists: "Backlog", "To do", "In progress", "Planned", "Done".
The user can only add cards in "Backlog". When the description is done the user can add them to the list "Plan" or "Implement". When it is set to Plan and Claude is picking it up it will just plan the task and write the output in the plan field of the task. While it is working on the task (planning) the task goes into the list "In progress". When it is ready with planning, it goes into "Planned". The user can read through the plan, do changes and add it to the list "Implement". Claude will pick it up from there to implement it. If there is a "Plan" in the task it uses this one to implement. If not claude uses the description. Everytime claude is working on a task it moves the task to "In progress". If the user moves the task from backlog directly to "Implement" the planning is skipped.
If there is any user input required the task will go into "User Input" till the user input is given. The conversation should happen within the task so the user does not have to switch to the console. 

### Architecture

The frontend should be React. The persistence should happen very simple in JSON files stored locally in the project. Claude should read the json files to know what to implement next and also should write into the json files to move the task into the right list. So there should be a status field in the task json. When this switches, the UI shows it automatically and live in the right status. When user input is needed this will also be written into the json file and shows in the UI. If the user reacts on the input request this is also written into json and claude can pick it automatically up from there. So the JSON files are the bridge between claude and the UI.
You need to decide if it is better to use one jsonfile with a array of tasks or multiple json files. There should be a command in claude that watches the json file(s) and does the actions that are needed. The order to work on what should be managed by the order of the list. Tasks on top come first.