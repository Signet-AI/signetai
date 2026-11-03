; benchmark generated from python API
(set-info :status unknown)
(declare-fun t_window () Real)
(declare-fun t_recorded () Real)
(declare-fun t_now () Real)
(declare-fun t_step () Real)
(declare-fun t_wall_recorded () Real)
(assert
 (> t_window 0.0))
(assert
 (>= t_recorded 0.0))
(assert
 (let ((?x663 (- t_now t_recorded)))
 (>= ?x663 t_window)))
(assert
 (> t_step 0.0))
(assert
 (let ((?x663 (- t_now t_recorded)))
(let ((?x397 (+ t_wall_recorded ?x663)))
(let ((?x152 (- ?x397 t_step)))
(let ((?x258 (- ?x152 t_wall_recorded)))
(let (($x768 (< ?x258 t_window)))
(let (($x372 (not $x768)))
(not $x372))))))))
(check-sat)
